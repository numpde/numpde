"""Check distance geometry and quantile ties without any embedding API calls."""

from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from build_neighborhoods import build, cosine_pairs


class NeighborhoodTests(unittest.TestCase):
    def test_cosine_geometry_ignores_scale_and_excludes_self_pairs(self):
        pairs = cosine_pairs([[2, 0], [3, 0], [0, 5], [-7, 0]])
        self.assertEqual(len(pairs), 6)
        self.assertTrue(all(source < target for source, target, _ in pairs))
        distances = {(a, b): d for a, b, d in pairs}
        self.assertAlmostEqual(distances[0, 1], 0)
        self.assertAlmostEqual(distances[0, 2], 1)
        self.assertAlmostEqual(distances[0, 3], 2)
        self.assertEqual([d for _, _, d in pairs], sorted(distances.values()))

    def test_cutoffs_include_all_ties_and_report_real_connectivity(self):
        inventory = {'projects': [{'id': name} for name in ('a', 'b', 'c')]}
        index = {'provider': 'test', 'model': 'orthogonal', 'dimensions': 3, 'input_fields': [],
                 'records': {'a': {'embedding': [1, 0, 0]}, 'b': {'embedding': [0, 1, 0]},
                             'c': {'embedding': [0, 0, 1]}}}
        result = build(inventory, index, 'test-hash')
        for cutoff in result['cutoffs']:
            self.assertEqual(cutoff['distance'], 1)
            self.assertEqual(cutoff['edge_count'], 3)
            self.assertEqual(cutoff['component_count'], 1)
            self.assertEqual(cutoff['isolated_node_count'], 0)
            self.assertEqual(cutoff['largest_component_size'], 3)

    def test_embedded_keeps_cutoff_edges_and_each_nodes_two_closest(self):
        names = ('a', 'b', 'c', 'd', 'e')
        vectors = ([1, 0], [0, 1], [.6, .8], [.8, .6], [-1, 0])
        inventory = {'projects': [{'id': name} for name in names]}
        index = {'provider': 'test', 'model': 'directions', 'dimensions': 2, 'input_fields': [],
                 'records': {name: {'embedding': vector} for name, vector in zip(names, vectors)}}
        result = build(inventory, index, 'test-hash')
        embedded = result['embedded']
        nearest = {tuple(result['pairs'][i][:2]) for i in embedded['nearest_pair_indices']}
        self.assertEqual(nearest, {(0, 3), (0, 2), (1, 2), (1, 3), (2, 3), (1, 4), (2, 4)})
        retained = {tuple(result['pairs'][i][:2]) for i in embedded['pair_indices']}
        # The outlier points left: its closest directions are up, then (.6,.8).
        self.assertIn((1, 4), retained)
        self.assertIn((2, 4), retained)
        self.assertNotIn((0, 4), retained)
        self.assertEqual(len(retained), embedded['edge_count'])
        for node in range(len(names)):
            closest = [tuple(pair[:2]) for pair in result['pairs'] if node in pair[:2]][:2]
            self.assertTrue(set(closest) <= retained)
        cutoff = next(c for c in result['cutoffs'] if c['quantile'] == .02)
        self.assertTrue({tuple(pair[:2]) for pair in result['pairs'][:cutoff['edge_count']]} <= retained)
        self.assertGreaterEqual(embedded['minimum_degree'], 2)
        self.assertEqual(embedded['isolated_node_count'], 0)


if __name__ == '__main__':
    unittest.main()
