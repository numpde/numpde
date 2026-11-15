#!/usr/bin/env python3
"""Check that an inventory parses and its contribution counts add up."""

import argparse
import json
from pathlib import Path

from project_metadata import refresh_project_work


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('inventory', type=Path, nargs='?', default=Path(__file__).resolve().parents[1] / 'data' / 'repos.json')
    args = parser.parse_args()
    document = json.loads(args.inventory.read_text())
    repositories = document['repositories']
    if len({r['id'] for r in repositories}) != len(repositories):
        raise ValueError('Cannot use the inventory: repository IDs are duplicated.')
    for repo in repositories:
        branch, work = repo['default_branch'], repo['user_work']
        if sum(branch['attribution'].values()) != branch['commit_count']:
            raise ValueError(f"{repo['full_name']}: default-branch attribution does not add up.")
        if work['confirmed_primary_author_commits'] + work['inferred_primary_author_commits'] + work['coauthor_only_commits'] != work['commit_count']:
            raise ValueError(f"{repo['full_name']}: personal contribution counts do not add up.")
        if len(set(work['commit_shas'])) != work['commit_count']:
            raise ValueError(f"{repo['full_name']}: contribution SHA membership does not match its count.")
    before = [p['user_work'] for p in document['projects']]
    refresh_project_work(document)
    if before != [p['user_work'] for p in document['projects']]:
        raise ValueError('Project activity is stale; refresh it from repository contribution SHAs.')
    print(f'Checked {len(repositories)} repository records.')


if __name__ == '__main__':
    main()
