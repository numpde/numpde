"""Derive project activity from repository membership and attributable commit SHAs."""


def refresh_project_work(inventory):
    repositories = {repo['id']: repo for repo in inventory['repositories']}
    covered = set()
    project_ids = set()
    for project in inventory['projects']:
        if project['id'] in project_ids:
            raise ValueError(f"Project identity is repeated: {project['id']}.")
        project_ids.add(project['id'])
        members = project['repository_ids']
        if not members:
            raise ValueError(f"Project {project['id']} has no repository records.")
        commits = set()
        starts, ends = [], []
        for repo_id in members:
            if repo_id not in repositories or repo_id in covered:
                raise ValueError(f"Project membership must assign each repository once: {repo_id}.")
            covered.add(repo_id)
            work = repositories[repo_id]['user_work']
            commits.update(work['commit_shas'])
            if work['first_activity_date']:
                starts.append(work['first_activity_date'])
                ends.append(work['last_activity_date'])
        project['user_work'] = {'commit_count': len(commits),
                                'first_activity_date': min(starts, default=None),
                                'last_activity_date': max(ends, default=None)}
    missing = repositories.keys() - covered
    if missing:
        raise ValueError('Assign newly inventoried repositories to projects before publishing: ' + ', '.join(sorted(missing)))
