#!/usr/bin/env python3
"""Compute cosine-distance neighborhoods from the saved embedding index.

Run with magnet-dev's Python (NumPy is the only nonstandard dependency).
No API requests are made. Quantiles use unique unordered, off-diagonal pairs;
all pairs tied at a cutoff are retained. The embedded view combines the 2%
cutoff with each project's two closest neighbors, as undirected edges.
"""

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path

import numpy as np

from embedding_index import read_index


ROOT = Path(__file__).resolve().parents[1]
QUANTILES = (.001, .0025, .005, .01, .02)


def cosine_pairs(vectors):
    """Return each unordered pair once, sorted by ascending cosine distance."""
    matrix = np.asarray(vectors, dtype=np.float64)
    if matrix.ndim != 2 or not np.isfinite(matrix).all():
        raise ValueError('Cannot compute neighborhoods: embeddings must be a finite rectangular matrix.')
    norms = np.linalg.norm(matrix, axis=1)
    if np.any(norms == 0):
        raise ValueError('Cannot compute cosine distances: an embedding has zero length.')
    normalized = matrix / norms[:, None]
    distances = 1 - np.clip(normalized @ normalized.T, -1, 1)
    source, target = np.triu_indices(len(matrix), k=1)
    order = np.argsort(distances[source, target], kind='stable')
    return [[int(source[i]), int(target[i]), float(distances[source[i], target[i]])] for i in order]


def connectivity(node_count, pairs):
    neighbors = [set() for _ in range(node_count)]
    for source, target, _ in pairs:
        neighbors[source].add(target)
        neighbors[target].add(source)
    remaining = set(range(node_count))
    sizes = []
    while remaining:
        component = set()
        todo = [next(iter(remaining))]
        while todo:
            node = todo.pop()
            if node in component:
                continue
            component.add(node)
            todo.extend(neighbors[node] - component)
        remaining -= component
        sizes.append(len(component))
    return {'isolated_node_count': sum(not adjacent for adjacent in neighbors),
            'component_count': len(sizes), 'largest_component_size': max(sizes, default=0),
            'minimum_degree': min(map(len, neighbors), default=0)}


def build(inventory, index, index_sha256):
    node_ids = [project['id'] for project in inventory['projects']]
    missing = set(node_ids) - index['records'].keys()
    if missing:
        raise ValueError('Cannot map projects without indexed embeddings: ' + ', '.join(sorted(missing)))
    if len(node_ids) < 3:
        raise ValueError('Cannot give each project two distinct neighbors: at least three projects are needed.')
    pairs = cosine_pairs([index['records'][repo_id]['embedding'] for repo_id in node_ids])
    distances = np.array([pair[2] for pair in pairs])
    cutoffs = []
    for quantile in QUANTILES:
        distance = float(np.quantile(distances, quantile, method='linear'))
        edge_count = int(np.searchsorted(distances, distance, side='right'))
        cutoffs.append({'quantile': quantile, 'distance': distance, 'edge_count': edge_count,
                        **connectivity(len(node_ids), pairs[:edge_count])})
    cutoff = next(c for c in cutoffs if c['quantile'] == .02)
    selected = set(range(cutoff['edge_count']))
    nearest = set()
    nearest_counts = [0] * len(node_ids)
    for pair_index, (source, target, _) in enumerate(pairs):
        # Count each endpoint's choices independently: incoming choices do not
        # replace that repository's own two nearest neighbors.
        if nearest_counts[source] < 2 or nearest_counts[target] < 2:
            selected.add(pair_index)
            nearest.add(pair_index)
        nearest_counts[source] = min(2, nearest_counts[source] + 1)
        nearest_counts[target] = min(2, nearest_counts[target] + 1)
    embedded = {'quantile': .02, 'nearest_neighbors': 2, 'cutoff_distance': cutoff['distance'],
                'cutoff_edge_count': cutoff['edge_count'], 'nearest_pair_indices': sorted(nearest),
                'pair_indices': sorted(selected), 'edge_count': len(selected),
                **connectivity(len(node_ids), [pairs[i] for i in sorted(selected)])}
    return {
        'schema_version': 3, 'node_type': 'project', 'created_at': datetime.now(timezone.utc).isoformat(),
        'embedding_source': {'sha256': index_sha256, 'provider': index['provider'],
                             'model': index['model'], 'dimensions': index['dimensions'],
                             'input_fields': index['input_fields']},
        'metric': 'cosine_distance', 'distance_definition': '1 - dot(a, b) / (norm(a) * norm(b))',
        'quantile_definition': 'NumPy linear quantiles over all unique unordered off-diagonal project pairs; retain distance <= cutoff, including ties. Smaller quantiles keep closer pairs. These cutoff statistics exclude the nearest-neighbor additions in embedded.',
        'pair_columns': ['source_node_index', 'target_node_index', 'distance'],
        'pair_order': 'ascending distance; ties retain inventory pair order',
        'embedded_definition': 'Union of all pairs at or below the 2% distance cutoff and each node\'s two closest other nodes. An edge is retained if either endpoint chooses it; undirected duplicates occur once. Equal-distance neighbor choices follow inventory pair order.',
        'node_ids': node_ids, 'pairs': pairs, 'cutoffs': cutoffs, 'embedded': embedded,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inventory', type=Path, default=ROOT / 'data' / 'repos.json')
    parser.add_argument('--index', type=Path, default=ROOT / 'data' / 'project-embeddings.npz')
    parser.add_argument('--output', type=Path, default=ROOT / 'data' / 'neighborhoods.json')
    args = parser.parse_args()
    if args.output.resolve() in (args.inventory.resolve(), args.index.resolve()):
        parser.error('--output must differ from the inventory and embedding index')
    raw = args.index.read_bytes()
    index = read_index(args.index)
    if index['provider'] != 'openai':
        parser.error('neighborhood maps require real embeddings; mock vectors are nonsemantic test data')
    result = build(json.loads(args.inventory.read_text()), index, hashlib.sha256(raw).hexdigest())
    args.output.parent.mkdir(parents=True, exist_ok=True)
    pending = args.output.with_suffix(args.output.suffix + '.pending')
    pending.write_text(json.dumps(result, ensure_ascii=False, separators=(',', ':'), allow_nan=False) + '\n')
    pending.replace(args.output)
    print(f"Wrote {len(result['node_ids'])} nodes and {len(result['pairs'])} pairwise distances to {args.output}.")
    for cutoff in result['cutoffs']:
        print(f"{cutoff['quantile']:.2%}: distance <= {cutoff['distance']:.6f}; "
              f"{cutoff['edge_count']} edges; {cutoff['isolated_node_count']} isolated; "
              f"{cutoff['component_count']} components; largest {cutoff['largest_component_size']}.")
    embedded = result['embedded']
    print(f"Embedded view: {embedded['edge_count']} edges; minimum degree {embedded['minimum_degree']}; "
          f"{embedded['component_count']} components; largest {embedded['largest_component_size']}.")


if __name__ == '__main__':
    main()
