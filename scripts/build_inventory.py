#!/usr/bin/env python3
"""Refresh measured inventory fields from a collected GitHub evidence directory.

Descriptions, categories, keywords, and assessments belong to the inventory.
This offline step preserves those annotations and never executes repository code.
"""

import argparse
from collections import Counter
from datetime import datetime, timedelta, timezone
import json
import math
from pathlib import Path
import re
from urllib.parse import quote

from project_metadata import refresh_project_work


def read_json(path):
    return json.loads(path.read_text())


def key(name):
    return name.replace("/", "__") + ".json"


def date(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


def sustained_work(commits):
    """Find the latest 14-day window with five nonmerge commits on three days."""
    days = Counter(date(c["authoredDate"]).date() for c in commits
                   if c["parents"]["totalCount"] < 2)
    for end in sorted(days, reverse=True):
        included = {d: n for d, n in days.items() if end - timedelta(days=13) <= d <= end}
        if len(included) >= 3 and sum(included.values()) >= 5:
            return {"start": min(included).isoformat(), "end": end.isoformat(),
                    "active_days": len(included), "nonmerge_commits": sum(included.values())}
    return None


def commit_ref(commit, name):
    if commit is None:
        return None
    return {"sha": commit["oid"], "authored_at": commit["authoredDate"],
            "committed_at": commit["committedDate"],
            "url": f"https://github.com/{name}/commit/{commit['oid']}"}


def coauthors(commit):
    if "authors" in commit:
        primary = commit["author"]
        return [a for a in commit["authors"]["nodes"]
                if (a["name"], a["email"]) != (primary["name"], primary["email"])]
    return [{"name": m[0].strip(), "email": m[1].strip()}
            for m in re.findall(r"([^\n\x1d]+?)\s*<([^>]+)>",
                                commit.get("coauthor_trailers", ""))]


def build(evidence, inventory):
    account = read_json(evidence / "account.json")
    login = account["login"]
    collected_at = account["collected_at"]
    metadata = {d["nameWithOwner"]: d for p in (evidence / "metadata").glob("*.json")
                if not p.name.endswith(".rest.json") for d in [read_json(p)]}
    previous = {r["full_name"]: r for r in inventory["repositories"]}
    absent = sorted(previous.keys() - metadata.keys())
    if absent:
        raise ValueError("Cannot refresh the inventory from a partial snapshot: evidence is missing "
                         f"for {len(absent)} existing repositories. The inventory has not been changed.")
    missing = sorted(metadata.keys() - previous.keys())
    if missing:
        raise ValueError("Cannot build the inventory: descriptions and assessments need review "
                         f"for these newly discovered repositories: {', '.join(missing)}. "
                         "The existing inventory has not been changed.")
    histories = {p.stem: read_json(p) for p in (evidence / "personal").glob("*.json")}
    defaults = {p.stem.replace("__", "/"): read_json(p)
                for p in (evidence / "history").glob("*.json")}
    pulls = read_json(evidence / "pull_requests.json")
    discovered = read_json(evidence / "discovery.json")
    affiliated = {r["full_name"] for r in discovered}
    external = read_json(evidence / "external_discovery.json")

    # GitHub-linked addresses are resolved in private evidence, never exported.
    linked_emails = set()
    linked_names = set()
    node_lists = [h["nodes"] for h in histories.values()] + [p["nodes"] for p in pulls]
    for nodes in node_lists:
        for c in nodes:
            for a in [c["author"], *coauthors(c)]:
                if (a.get("user") or {}).get("login", "").lower() == login.lower():
                    linked_emails.add(a["email"].lower())
                    linked_names.add(a["name"])
    if not linked_emails:
        raise ValueError("Cannot attribute commits: the evidence contains no author address "
                         f"linked by GitHub to {login!r}. The inventory has not been changed.")

    inferred_pairs = set()
    inferred_shas = set()
    for name, meta in metadata.items():
        if name.split("/")[0].lower() != login.lower():
            continue
        branch_data = read_json(evidence / "branches" / key(name))
        for b in branch_data["nodes"]:
            h = histories[b["target"]["oid"]]
            for c in h["nodes"]:
                a = c["author"]
                local_address = (not a["email"] or a["email"].lower().endswith("@local")
                                 or a["email"].lower().startswith(login.lower() + "@"))
                if a["name"].lower() in {"ra", "ra@euler"} and local_address:
                    inferred_pairs.add((a["name"], a["email"].lower()))
                    inferred_shas.add(c["oid"])

    def attribution(author, name, sha):
        email = author["email"].lower()
        user = (author.get("user") or {}).get("login", "")
        if user.lower() == login.lower() or email in linked_emails:
            return "user_confirmed"
        owned = name.split("/")[0].lower() == login.lower()
        if (author["name"], email) in inferred_pairs and (owned or bool(email) or sha in inferred_shas):
            return "user_inferred"
        if user:
            return "automation" if user.endswith("[bot]") else "other_authors"
        if re.search(r"\[bot\]|ip-reporter|dependabot", author["name"], re.I):
            return "automation"
        if author["name"].lower() in {"ra", "ra@euler", "r", "numpde", "romanize", "andreevr", ""}:
            return "unresolved"
        return "other_authors"

    def personal(nodes, name):
        return {c["oid"]: c for c in nodes if any(
            attribution(a, name, c["oid"]).startswith("user_")
            for a in [c["author"], *coauthors(c)])}

    repositories = []
    for name, meta in sorted(metadata.items(), key=lambda item: item[0].lower()):
        old = previous[name]
        owned = name.split("/")[0].lower() == login.lower()
        default = meta["defaultBranchRef"]
        head = default["target"]["oid"] if default else None
        total = default["target"]["history"]["totalCount"] if default else 0
        history = defaults.get(name) or histories.get(head)
        if not history and total:
            raise ValueError(f"Cannot measure {name}: commit evidence for head {head} is missing.")
        nodes = history["nodes"] if history else []
        complete = len(nodes) == total and (not history or history.get("complete", True))
        counts = Counter(attribution(c["author"], name, c["oid"]) for c in nodes)
        counts["unclassified"] = total - len(nodes)
        partition = {k: counts[k] for k in ["user_confirmed", "user_inferred", "other_authors",
                                          "automation", "unresolved", "unclassified"]}
        branch_data = read_json(evidence / "branches" / key(name))
        if owned and branch_data["pageInfo"]["hasNextPage"]:
            raise ValueError(f"Cannot measure all branches of {name}: branch pagination is incomplete.")
        work = personal(nodes, name)
        covered_branches = []
        sources = {history["source"]} if history else set()
        for b in branch_data["nodes"]:
            if not owned and (not default or b["name"] != default["name"]):
                continue
            bh = histories[b["target"]["oid"]]
            if not bh.get("complete", True):
                raise ValueError(f"Cannot measure {name}: personal history is incomplete for {b['name']}.")
            work.update(personal(bh["nodes"], name))
            sources.add(bh["source"])
            covered_branches.append(b["target"]["oid"])
        repo_pulls = [p for p in pulls if p["repo"] == name]
        for pr in repo_pulls:
            work.update(personal(pr["nodes"], name))

        parent = meta.get("parent")
        lineage = {"github_fork": meta["isFork"], "parent": None,
                   "default_branch_comparison": None}
        inherited_personal = set()
        if parent:
            pb = parent.get("defaultBranchRef")
            lineage["parent"] = {"full_name": parent["nameWithOwner"], "url": parent["url"],
                                  "default_branch": pb["name"] if pb else None,
                                  "head_sha": pb["target"]["oid"] if pb else None}
            if pb:
                ph = histories[pb["target"]["oid"]]
                inherited_personal = set(personal(ph["nodes"], parent["nameWithOwner"])) & work.keys()
            fp = evidence / "forks" / key(name)
            if fp.exists():
                comparison = read_json(fp)
                if "error" in comparison:
                    lineage["comparison_error"] = "GitHub could not compare the pinned branches."
                else:
                    lineage["default_branch_comparison"] = {
                        "status": comparison["status"], "ahead_of_parent": comparison["ahead_by"],
                        "behind_parent": comparison["behind_by"],
                        "inherited_commit_count": total - comparison["ahead_by"],
                        "fork_specific_commit_count": comparison["ahead_by"],
                        "merge_base_sha": comparison["merge_base"],
                        "url": f"https://github.com/{name}/compare/{comparison['base']}...{comparison['head']}"}
        if name == "numpde/fork-of-MoLFormer-XL-both-10pct":
            lineage["declared_derivative"] = {"url": "https://huggingface.co/ibm/MoLFormer-XL-both-10pct",
                                               "evidence": "Repository description and model README; not a GitHub fork."}
        if name == "numpde/als2_qichang":
            lineage["declared_derivative"] = {"evidence": "Repository description credits the original code to Qi Chang."}
        if name == "numpde/nmr-to-structure-lite":
            lineage["declared_derivative"] = {"evidence": "README credits adaptations from rxn4chemistry spectroscopy and NMR-to-structure code."}

        commits = list(work.values())
        own_new = [c for sha, c in work.items() if sha not in inherited_personal]
        nonmerge = [c for c in own_new if c["parents"]["totalCount"] < 2]
        days = sorted({date(c["authoredDate"]).date().isoformat() for c in commits})
        effort_days = {date(c["authoredDate"]).date() for c in nonmerge}
        effort_months = {d.strftime("%Y-%m") for d in effort_days}
        assessments = dict(old["assessments"])
        if "amount_of_work" not in assessments:
            score = min(100, round(15 * math.log10(1 + len(nonmerge))
                                  + 18 * math.log10(1 + len(effort_days))
                                  + 5 * math.log10(1 + len(effort_months))))
            assessments["amount_of_work"] = {"score": score, "confidence": "low",
                "rationale": f"Activity proxy: {len(nonmerge)} attributable nonmerge commits, "
                f"{len(effort_days)} active days, {len(effort_months)} active months; excludes commits also present "
                "in the current parent default branch. Bulk imports, squashes, uncommitted work, and "
                "automation under personal identities can distort this estimate.",
                "assessed_at": collected_at}
        if "difficulty" not in assessments:
            assessments["difficulty"] = {"score": None, "confidence": "low",
                "rationale": "Contribution difficulty requires a patch-specific assessment; codebase complexity and commit counts do not establish it.",
                "method": "unassessed", "assessed_at": collected_at}
        for assessment in assessments.values():
            assessment.setdefault("assessed_at", collected_at)

        root_paths = [e["name"] for e in (meta.get("root") or {}).get("entries", [])]
        readme_paths = [n for n in root_paths if n.lower() in {"readme", "readme.md", "readme.rst", "readme.txt"}]
        target_file = evidence / "targets" / key(name)
        reviewed = read_json(target_file) if target_file.exists() else {}
        reviewed_paths = sorted(set(readme_paths) | set(reviewed))
        notes = []
        if not complete:
            notes.append("Large default history was queried by known author addresses; the remaining commits are unclassified, not asserted to be other people's work.")
        if any(attribution(c["author"], name, c["oid"]) == "user_inferred" for c in commits):
            notes.append("Some personal attribution relies on inferred RA identities; inferred counts are separate from confirmed counts.")
        if meta["isFork"]:
            notes.append("Inherited user-authored commits are visible here and may also appear in the upstream record; do not sum repository activity as unique global effort.")
        if old.get("description_confidence") == "low":
            notes.append("The purpose is poorly documented; description and keywords need owner review.")
        if not owned:
            notes.append("Personal activity covers the default branch and discovered authored pull requests; unrelated upstream branches were not exhaustively scanned.")
        languages = [{"name": e["node"]["name"], "bytes": e["size"]} for e in meta["languages"]["edges"]]
        user_primary = Counter(attribution(c["author"], name, c["oid"]) for c in commits)
        shared = sum(any(attribution(a, name, c["oid"]) == "other_authors" for a in [c["author"], *coauthors(c)]) for c in commits)
        repositories.append({
            **old,
            "id": "github:" + name, "source": "github", "full_name": name,
            "url": meta["url"], "visibility": "private" if meta["isPrivate"] else "public",
            "relationship": "owned" if owned else "collaborator" if name in affiliated else "contribution" if name in {x["repo"] for x in external["commits"] + external["pull_requests"]} else "checked_out_reference",
            "archived": meta["isArchived"], "empty": meta["isEmpty"], "created_at": meta["createdAt"],
            "description": old["description"], "description_confidence": old["description_confidence"],
            "categories": old["categories"], "keywords": old["keywords"],
            "github_topics": [t["topic"]["name"] for t in meta["repositoryTopics"]["nodes"]],
            "languages": languages, "reported_git_size_kib": meta["diskUsage"], "lineage": lineage,
            "default_branch": {"name": default["name"] if default else None, "head_sha": head,
                "last_commit": {"sha": head, "committed_at": default["target"]["committedDate"],
                                "authored_at": default["target"]["authoredDate"],
                                "url": f"https://github.com/{name}/commit/{head}"} if default else None,
                "commit_count": total, "attribution": partition,
                "complete_author_scan": complete, "user_coauthored_commit_count": sum(
                    any(attribution(a, name, c["oid"]).startswith("user_") for a in coauthors(c)) for c in nodes)},
            "user_work": {"scope": "all_github_branch_heads" if owned else "default_branch_and_discovered_authored_pull_requests",
                "commit_shas": sorted(work),
                "branch_heads_scanned": len(set(covered_branches)),
                "commit_count": len(commits), "confirmed_primary_author_commits": user_primary["user_confirmed"],
                "inferred_primary_author_commits": user_primary["user_inferred"],
                "coauthor_only_commits": sum(not attribution(c["author"], name, c["oid"]).startswith("user_") for c in commits),
                "shared_with_other_authors_commits": shared,
                "also_in_parent_default_branch": len(inherited_personal),
                "distinct_from_parent_default_branch": len(own_new),
                "nonmerge_commits": sum(c["parents"]["totalCount"] < 2 for c in commits),
                "active_days": len(days), "first_activity_date": days[0] if days else None,
                "last_activity_date": days[-1] if days else None,
                "last_commit": commit_ref(max(commits, key=lambda c: date(c["authoredDate"])), name) if commits else None,
                "last_sustained_work": sustained_work(commits),
                "last_sustained_work_distinct_from_parent": sustained_work(own_new),
                "last_authored_pull_request_date": max((p["created_at"] for p in repo_pulls), default=None),
                "discovered_authored_pull_requests": [{k: v for k, v in p.items() if k not in {"nodes", "repo"}} for p in repo_pulls]},
            "assessments": assessments,
            "evidence": {"collected_at": collected_at, "history_sources": sorted(sources),
                "metadata_url": f"https://api.github.com/repos/{name}",
                "reviewed_files": old.get("evidence", {}).get("reviewed_files", [
                    {"path": p, "url": f"https://github.com/{name}/blob/{head}/{quote(p)}"} for p in reviewed_paths]),
                "root_listing_reviewed": True, "notes": notes}})

    retained = set(metadata)
    excluded = sorted({c["repo"] for c in external["commits"]} - retained)
    inventory.update({"schema_version": inventory.get("schema_version", "1.0.0"), "updated_at": collected_at,
        "account": {"source": "github", "login": login, "url": f"https://github.com/{login}",
                    "github_numeric_id": account["databaseId"]},
        "scope": {"sources_included": ["github"], "sources_deferred": ["gitlab", "bitbucket", "other_git_hosts"],
            "includes_private": True, "includes_archived": True, "includes_forks": True,
            "discovery": "Authenticated user/repos with owner, collaborator, and organization-member affiliations; local GitHub remotes; authored external commits and pull requests.",
            "accessible_account_repositories": len(affiliated), "repository_count": len(repositories),
            "excluded_inherited_commit_mirrors": [{"full_name": n, "reason": "The same authored commit SHA is carried by an upstream repository already included; no separate direct contribution was found."} for n in excluded],
            "limitations": ["GitHub access and search indexing bound discovery; deleted, inaccessible, and unindexed projects cannot be guaranteed complete.",
                "Only GitHub-hosted repositories are included. Local repositories with no remote and repositories on other hosts await later review.",
                "Owned repositories cover current branch heads, not deleted branches, unreachable commits, tags-only work, or uncommitted changes.",
                "Descriptions and estimates summarize inspected documentation and selected files; repository code was not executed."]},
        "methodology": {**inventory.get("methodology", {}), "commit_counts": "Unique commits reachable from the pinned default-branch head, including merges. Attribution partitions this total. user_work separately deduplicates attributable SHAs across its stated scope; these two counts must not be subtracted from one another.",
            "last_commit": "Default-branch tip and its Git committer timestamp; not GitHub pushed_at. User activity and sustained-work dates use authored timestamps converted to UTC.",
            "last_sustained_work": "Latest inclusive 14-calendar-day window with at least five attributable nonmerge commits on at least three distinct UTC dates. Null means no qualifying window was observed, not proof of no sustained effort.",
            "confirmed_identity": "GitHub maps the author/coauthor to the authenticated account, or the address exactly matches one linked to that account elsewhere in the evidence. Actual addresses are not exported.",
            "inferred_identity": "RA/ra local or email-less signatures, or a numpde-address signature, observed in account-owned repositories. External attribution requires an exact nonempty address/signature match or the same SHA in owned history. These are plausible identity matches, not cryptographic proof.",
            "other_authors": "A different linked GitHub account or a distinct noncandidate author signature; automation is classified separately where recognized. Unclassified large-history commits are not presumed to be other humans.",
            "coauthorship": "GitHub author lists (up to ten names per commit) and local Co-authored-by trailers identify shared contributions. A commit may count once in user_work and also be marked shared; effort shares are not inferred from author order.",
            "forks": "The default branch is compared against a pinned current parent default branch. User SHAs also reachable from that parent are marked inherited; distinct-from-parent does not prove sole original authorship. Upstream-merged work can move into the inherited category.",
            "difficulty": "Contribution difficulty is distinct from whole-repository complexity. Generic small-patch estimates based on codebase scope or commit counts were withdrawn. Unknown is null; new difficulty scores require an explicit assessment. Merged project scores are not sums or maxima of repository estimates.",
            "amount_of_work": "0-100 historical effort estimate. Initial activity proxy: min(100, round(15*log10(1+nonmerge_commits) + 18*log10(1+active_days) + 5*log10(1+active_months))), excluding current-parent inherited SHAs. Curated overrides explain bulk imports and work not represented by commit frequency. This is not hours, remaining work, or productivity.",
            "assessment_refresh": "Existing descriptions, categories, keywords, and all assessment objects are preserved. Their assessed_at timestamps can precede measured-field refreshes; reassess them deliberately after reviewing new evidence.",
            "privacy": "Repository identity/visibility, GitHub links, aggregate activity, attributable commit SHAs, user alias names, and sanitized descriptions are exported. Raw addresses, commit messages, file contents, credentials, host addresses, and runtime configuration remain outside the checkout."},
        "identities": {"confirmed_alias_names": sorted(linked_names),
            "inferred_alias_names": sorted({n for n, _ in inferred_pairs}),
            "evidence": "GitHub commit author/coauthor mappings plus cross-repository local signature continuity; private raw evidence is retained outside this checkout.",
            "limitations": "Git attribution does not distinguish hand-written, agent-assisted, generated, or automatically committed work under the same identity."},
        "collection": {"method": "Read-only GitHub API queries and existing local Git objects; documentation and selected files support the retained annotations.",
            "clones_created": 0, "repository_code_executed": False,
            "private_evidence_snapshot": evidence.name,
            "default_branch_histories_fully_scanned": sum(r["default_branch"]["complete_author_scan"] for r in repositories),
            "default_branch_histories_author_filtered": sum(not r["default_branch"]["complete_author_scan"] for r in repositories)},
        "repositories": repositories})
    if 'projects' in inventory:
        refresh_project_work(inventory)
    return inventory


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--inventory", type=Path, default=Path(__file__).resolve().parents[1] / "data" / "repos.json")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    result = build(args.evidence, read_json(args.inventory))
    output = args.output or args.inventory
    pending = output.with_suffix(output.suffix + ".pending")
    pending.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n")
    pending.replace(output)
    print(f"Wrote {len(result['repositories'])} repositories to {output}.")


if __name__ == "__main__":
    main()
