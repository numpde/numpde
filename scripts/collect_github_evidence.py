#!/usr/bin/env python3
"""Collect private GitHub evidence without cloning or executing repository code.

Requires authenticated gh and Git. Metadata stays in the requested snapshot
directory; build_inventory.py exports only selected, sanitized aggregate fields.
"""

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import subprocess


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False) + "\n")


def gh(endpoint, query=None, paginate=False):
    command = ["gh", "api", endpoint]
    payload = None
    if query is not None:
        command += ["--input", "-"]
        payload = json.dumps({"query": query})
    if paginate:
        command += ["--paginate", "--slurp"]
    result = subprocess.run(command, input=payload, text=True, capture_output=True, timeout=180)
    if result.returncode:
        raise RuntimeError(f"Cannot collect GitHub evidence from {endpoint.split('?')[0]!r}; "
                           "gh returned a failure. Check authenticated read access and network access. "
                           "The inventory has not been changed.")
    data = json.loads(result.stdout)
    if isinstance(data, dict) and data.get("errors"):
        kinds = sorted({error.get("type", "GRAPHQL_ERROR") for error in data["errors"]})
        raise RuntimeError(f"Cannot collect complete GitHub evidence: GraphQL returned {kinds}. "
                           "The private snapshot may be partial; the inventory has not been changed.")
    return data["data"] if query is not None else data


def local_checkouts(root):
    paths = {}
    for path in root.iterdir():
        if not (path / ".git").exists():
            continue
        result = subprocess.run(["git", "-C", str(path), "remote", "get-url", "origin"],
                                text=True, capture_output=True, timeout=15)
        match = re.search(r"github\.com[:/]([^\s]+)", result.stdout)
        if match:
            name = match[1].removesuffix(".git")
            paths.setdefault(name.lower(), []).append(path)
    return paths


def local_history(paths, sha, count):
    for path in paths:
        result = subprocess.run([
            "git", "-C", str(path), "log", sha,
            "--format=%H%x1f%aN%x1f%aE%x1f%aI%x1f%cI%x1f%P%x1f%s%x1f"
            "%(trailers:key=Co-authored-by,valueonly,separator=%x1d)%x1e"],
            text=True, capture_output=True, timeout=120)
        if result.returncode:
            continue  # A local checkout need not contain the pinned remote object.
        nodes = []
        for record in result.stdout.split("\x1e"):
            record = record.strip("\n")
            if not record:
                continue
            oid, name, email, authored, committed, parents, subject, trailers = record.split("\x1f", 7)
            nodes.append({"oid": oid, "author": {"name": name, "email": email},
                          "authoredDate": authored, "committedDate": committed,
                          "parents": {"totalCount": len(parents.split())},
                          "messageHeadline": subject, "coauthor_trailers": trailers})
        # This also rejects shallow or incomplete local history.
        if len(nodes) == count:
            return {"source": "local_git_at_github_branch_head", "nodes": nodes,
                    "totalCount": count, "complete": True}
    return None


def remote_history(name, sha, emails=None):
    owner, repo = name.split("/")
    nodes = []
    cursor = None
    while True:
        after = ",after:" + json.dumps(cursor) if cursor else ""
        author = ",author:{emails:" + json.dumps(sorted(emails)) + "}" if emails is not None else ""
        query = '''query{repository(owner:%s,name:%s){object(oid:%s){... on Commit{
          history(first:100%s%s){totalCount pageInfo{hasNextPage endCursor} nodes{
            oid authoredDate committedDate messageHeadline author{name email user{login}}
            authors(first:10){nodes{name email user{login}}} parents(first:0){totalCount}
          }}}}}}''' % (json.dumps(owner), json.dumps(repo), json.dumps(sha), after, author)
        history = gh("graphql", query)["repository"]["object"]["history"]
        nodes.extend(history["nodes"])
        if not history["pageInfo"]["hasNextPage"]:
            break
        cursor = history["pageInfo"]["endCursor"]
    return {"source": "github_graphql_author_email_filter" if emails is not None else "github_graphql_pinned_default_head",
            "nodes": nodes, "totalCount": history["totalCount"], "complete": True}


def metadata(name, login):
    owner, repo = name.split("/")
    owned = owner.lower() == login.lower()
    refs = '''refs(refPrefix:"refs/heads/",first:100){totalCount pageInfo{hasNextPage endCursor}
              nodes{name target{oid ... on Commit{history(first:0){totalCount}}}}}''' if owned else ""
    query = '''query{repository(owner:%s,name:%s){
      nameWithOwner url isPrivate isFork isArchived isEmpty createdAt pushedAt diskUsage description
      repositoryTopics(first:30){nodes{topic{name}}}
      languages(first:10,orderBy:{field:SIZE,direction:DESC}){edges{size node{name}}}
      parent{nameWithOwner url defaultBranchRef{name target{oid ... on Commit{history(first:0){totalCount}}}}}
      defaultBranchRef{name target{oid ... on Commit{committedDate authoredDate author{name email user{login}}
        history(first:0){totalCount}}}}
      readme:object(expression:"HEAD:README.md"){... on Blob{text byteSize}}
      readmerst:object(expression:"HEAD:README.rst"){... on Blob{text byteSize}}
      root:object(expression:"HEAD:"){... on Tree{entries{name type}}}
      %s }}''' % (json.dumps(owner), json.dumps(repo), refs)
    data = gh("graphql", query)["repository"]
    if data is None:
        raise ValueError(f"Cannot inspect {name}: GitHub returned no accessible repository. "
                         "The inventory has not been changed.")
    if not owned:
        branch = data["defaultBranchRef"]
        data["refs"] = {"totalCount": None, "pageInfo": {"hasNextPage": False, "endCursor": None},
                        "nodes": [{"name": branch["name"], "target": branch["target"]}] if branch else []}
    else:
        refs = data["refs"]
        while refs["pageInfo"]["hasNextPage"]:
            query = '''query{repository(owner:%s,name:%s){refs(refPrefix:"refs/heads/",first:100,after:%s){
              totalCount pageInfo{hasNextPage endCursor}
              nodes{name target{oid ... on Commit{history(first:0){totalCount}}}}}}}''' % (
                  json.dumps(owner), json.dumps(repo), json.dumps(refs["pageInfo"]["endCursor"]))
            page = gh("graphql", query)["repository"]["refs"]
            refs["nodes"].extend(page["nodes"])
            refs["pageInfo"] = page["pageInfo"]
    return data


def search_items(endpoint):
    pages = gh(endpoint, paginate=True)
    if any(p.get("incomplete_results") or p["total_count"] > 1000 for p in pages):
        raise ValueError("Cannot complete contribution discovery: GitHub search is incomplete or "
                         "exceeds its 1,000-result limit. Partition the search before building an inventory.")
    return [item for page in pages for item in page["items"]]


def collect(args):
    output = args.output.resolve()
    checkout = Path(__file__).resolve().parents[1]
    if output.is_relative_to(checkout):
        raise ValueError("Cannot store raw GitHub evidence inside this checkout: it contains private "
                         "author addresses and source text. Choose a directory under /tmp/repos/github/.")
    if output.exists():
        raise ValueError(f"Cannot start a fresh snapshot at {output}: the directory already exists. "
                         "Choose a new directory to keep observations from different runs separate.")
    output.mkdir(parents=True, mode=0o700)
    for directory in ["metadata", "branches", "history", "personal", "forks", "targets"]:
        (output / directory).mkdir()
    user = gh("user")
    login = user["login"]
    account = {"login": login, "id": user["node_id"], "databaseId": user["id"],
               "collection_started_at": datetime.now(timezone.utc).isoformat()}
    paths = local_checkouts(args.local_repos)
    if args.repo:
        names = set(args.repo)
        discovered, commits, prs = [], [], []
    else:
        pages = gh("user/repos?per_page=100&affiliation=owner,collaborator,organization_member&sort=full_name", paginate=True)
        discovered = [{"full_name": r["full_name"]} for page in pages for r in page]
        commits = [{"repo": c["repository"]["full_name"], "sha": c["sha"]} for c in search_items(
            f"search/commits?q=author%3A{login}+-user%3A{login}&per_page=100")]
        prs = [{"repo": p["repository_url"].split("/repos/")[1], "number": p["number"],
                "url": p["html_url"], "state": p["state"], "created_at": p["created_at"],
                "updated_at": p["updated_at"]} for p in search_items(
                    f"search/issues?q=author%3A{login}+is%3Apr+-user%3A{login}&per_page=100")]
        known = json.loads(args.inventory.read_text())
        if known["account"]["login"].lower() != login.lower():
            raise ValueError("Cannot refresh the inventory: gh is authenticated as a different account.")
        names = {r["full_name"] for r in known["repositories"]} | {r["full_name"] for r in discovered}
        names |= {p["repo"] for p in prs}
        # Commit-only hits can be mirrors. Retain them for review rather than
        # automatically treating inherited commits as new direct contributions.
    write_json(output / "discovery.json", discovered)
    write_json(output / "external_discovery.json", {"commits": commits, "pull_requests": prs})
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        metas = list(pool.map(lambda n: metadata(n, login), sorted(names)))
    metas = {m["nameWithOwner"]: m for m in metas}
    for name, meta in metas.items():
        filename = name.replace("/", "__") + ".json"
        write_json(output / "branches" / filename, meta.pop("refs"))
        write_json(output / "metadata" / filename, meta)
    print(f"Collected metadata for {len(metas)} repositories.", flush=True)

    def default_history(item):
        name, meta = item
        branch = meta["defaultBranchRef"]
        if not branch:
            return name, {"source": "github_graphql_empty", "nodes": [], "totalCount": 0, "complete": True}
        sha = branch["target"]["oid"]
        count = branch["target"]["history"]["totalCount"]
        history = local_history(paths.get(name.lower(), []), sha, count)
        if history is None and count <= args.full_history_limit:
            history = remote_history(name, sha)
        return name, history

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        defaults = dict(pool.map(default_history, metas.items()))
    emails = {"", f"{user['id']}+{login}@users.noreply.github.com", f"{login}@users.noreply.github.com"}
    for name, history in defaults.items():
        meta = metas[name]
        authors = [meta["defaultBranchRef"]["target"]["author"]] if meta["defaultBranchRef"] else []
        if history:
            for c in history["nodes"]:
                authors.extend([c["author"], *c.get("authors", {}).get("nodes", [])])
        for author in authors:
            if (author.get("user") or {}).get("login", "").lower() == login.lower():
                emails.add(author["email"])
            elif name.split("/")[0].lower() == login.lower() and author["name"].lower() in {"ra", "ra@euler"}:
                email = author["email"].lower()
                if not email or email.endswith("@local") or email.startswith(login.lower() + "@"):
                    emails.add(author["email"])
    jobs = {}
    for name, meta in metas.items():
        filename = name.replace("/", "__") + ".json"
        branch_data = json.loads((output / "branches" / filename).read_text())
        for b in branch_data["nodes"]:
            sha, count = b["target"]["oid"], b["target"]["history"]["totalCount"]
            history = defaults[name] if meta["defaultBranchRef"] and sha == meta["defaultBranchRef"]["target"]["oid"] else None
            if history is None:
                history = local_history(paths.get(name.lower(), []), sha, count)
            if history is not None:
                write_json(output / "personal" / (sha + ".json"), history)
            else:
                jobs[sha] = name
        parent = meta.get("parent")
        if parent and parent["defaultBranchRef"]:
            jobs[parent["defaultBranchRef"]["target"]["oid"]] = parent["nameWithOwner"]
    jobs = {sha: name for sha, name in jobs.items() if not (output / "personal" / (sha + ".json")).exists()}

    def filtered_history(item):
        sha, name = item
        history = remote_history(name, sha, emails)
        write_json(output / "personal" / (sha + ".json"), history)

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        list(pool.map(filtered_history, jobs.items()))
    for name, meta in metas.items():
        filename = name.replace("/", "__") + ".json"
        branch = meta["defaultBranchRef"]
        history = defaults[name]
        if history is None:
            history = json.loads((output / "personal" / (branch["target"]["oid"] + ".json")).read_text())
        write_json(output / "history" / filename, history)
        parent = meta.get("parent")
        if parent and branch and parent["defaultBranchRef"]:
            base = parent["defaultBranchRef"]["target"]["oid"]
            head = branch["target"]["oid"]
            comparison = gh(f"repos/{name}/compare/{base}...{head}?per_page=1")
            result = {k: comparison[k] for k in ["status", "ahead_by", "behind_by", "total_commits"]}
            result.update(base=base, head=head, merge_base=comparison["merge_base_commit"]["sha"])
            write_json(output / "forks" / filename, result)
    for pr in prs:
        pages = gh(f"repos/{pr['repo']}/pulls/{pr['number']}/commits?per_page=100", paginate=True)
        pr["nodes"] = []
        for page in pages:
            for c in page:
                author = c["commit"]["author"]
                pr["nodes"].append({"oid": c["sha"],
                    "author": {"name": author["name"], "email": author["email"],
                               "user": {"login": c["author"]["login"]} if c["author"] else None},
                    "authoredDate": author["date"], "committedDate": c["commit"]["committer"]["date"],
                    "parents": {"totalCount": len(c["parents"])},
                    "messageHeadline": c["commit"]["message"].split("\n")[0]})
    write_json(output / "pull_requests.json", prs)
    account["collected_at"] = datetime.now(timezone.utc).isoformat()
    write_json(output / "account.json", account)
    print(f"Snapshot completed at {output}. Commit-only discovery candidates remain available for review.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--inventory", type=Path, default=Path(__file__).resolve().parents[1] / "data" / "repos.json")
    parser.add_argument("--local-repos", type=Path, default=Path.home() / "repos")
    parser.add_argument("--repo", action="append", help="Collect only this owner/repo; repeat for a bounded probe.")
    parser.add_argument("--workers", type=int, choices=range(1, 9), default=4)
    parser.add_argument("--full-history-limit", type=int, default=7000)
    collect(parser.parse_args())


if __name__ == "__main__":
    main()
