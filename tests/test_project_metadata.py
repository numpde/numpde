"""Project identity must not double-count a contribution visible in two remotes."""

import copy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from project_metadata import refresh_project_work


class ProjectMetadataTests(unittest.TestCase):
    def test_shared_commit_is_counted_once_and_repository_records_stay_separate(self):
        upstream = {'id': 'upstream', 'user_work': {'commit_shas': ['shared-fix'],
                    'first_activity_date': '2020-12-27', 'last_activity_date': '2020-12-27'}}
        fork = copy.deepcopy(upstream)
        fork['id'] = 'fork'
        project = {'id': 'project:rna-sieve', 'repository_ids': ['upstream', 'fork']}
        inventory = {'repositories': [upstream, fork], 'projects': [project]}
        before = copy.deepcopy(inventory['repositories'])
        refresh_project_work(inventory)
        self.assertEqual(project['user_work']['commit_count'], 1)
        self.assertEqual(inventory['repositories'], before)
        # A newly observed fork change updates the union, not a summed counter.
        fork['user_work']['commit_shas'].append('local-change')
        fork['user_work']['last_activity_date'] = '2021-01-01'
        refresh_project_work(inventory)
        self.assertEqual(project['user_work']['commit_count'], 2)
        self.assertEqual(project['user_work']['last_activity_date'], '2021-01-01')

    def test_new_repository_requires_an_explicit_identity_decision(self):
        inventory = {'repositories': [{'id': 'new-remote'}], 'projects': []}
        with self.assertRaisesRegex(ValueError, 'Assign newly inventoried repositories'):
            refresh_project_work(inventory)


if __name__ == '__main__':
    unittest.main()
