`../data/repos.json` owns the repository descriptions, categories, keywords, and
subjective assessments. Its `methodology` explains the activity measures and
attribution rules. Scores describe historical work, not a backlog or time sheet.

Collection uses Python's standard library, Git, and an authenticated `gh` CLI.
They do not clone repositories, install dependencies, or run repository code.

`embed_projects.py` and `build_neighborhoods.py` additionally require NumPy
(available in `magnet-dev`). `data/project-embeddings.npz` stores the vectors as
a compressed float64 matrix and keeps indexing fingerprints, original input
text, and timestamps in the same archive. Loading disables object pickles.
Unchanged and minor edits reuse the saved vectors; new batches save atomically.
`data/neighborhoods.json` is the derived graph loaded by the page; the page never
loads the embedding archive. No page build is needed.

```bash
python3 -B scripts/embed_projects.py --key-file .openai-embedding-key.txt
python3 -B scripts/build_neighborhoods.py
```

To collect a fresh snapshot from the checkout root:

```bash
inventory_snapshot="/tmp/repos/github/inventory-$(date -u +%Y%m%dT%H%M%SZ)"
python3 -B scripts/collect_github_evidence.py --output "$inventory_snapshot"
python3 -B scripts/build_inventory.py --evidence "$inventory_snapshot"
python3 -B scripts/validate_inventory.py
```

Raw snapshots contain author addresses and source text and stay outside this
checkout. The initial snapshot is `/tmp/repos/github/inventory-2026-11-15`.

The collector includes accessible account repositories, known inventory entries,
and discovered external pull-request targets. Commit-only search hits remain in
`external_discovery.json` for review because many are inherited mirrors. Review
new candidates and add their descriptions and assessments to `repos.json` before
building; the builder reports missing annotations rather than inventing them.

Owned repositories cover all current branch heads. Other repositories cover
their default branch and discovered authored pull requests. Large upstream
histories use author-filtered queries; their remaining commits stay unclassified.

The builder preserves existing descriptions, source links, assessment objects,
and semantic annotations, including their curation dates. Refreshing measurements
does not reassess scores or relationships. Review those deliberately when the
underlying projects change.

For a small collection probe, repeat `--repo owner/name` as needed. Such a partial
snapshot cannot replace the full inventory. No GitLab or Bitbucket discovery is
performed in this phase.

Semantic graph data also lives in `repos.json`:

- `links` contains repository-to-repository edges with stable `source` and
  `target` IDs, a relationship `type`, a specific `label`, and an `explanation`.
- `link_types` defines the meaning and direction of each relationship. Arrows
  follow source to target; symmetric relationships are stored once.
- Each edge distinguishes an established relationship, an interpretation, or a
  prospective opportunity through `basis`. `confidence` describes certainty;
  `strength` describes editorial salience for graph display.
- `work_context_types` defines overlapping repository `work_contexts`, including
  academic work, exploration, and toy problems. These describe intent and form,
  not quality or current deployment status.
- `themes` contains recurring questions. Repository `theme_ids` can generate
  optional theme nodes and membership edges. Edge `theme_ids` explain which
  questions a particular relationship addresses.
- Evidence references select existing repository fields. Follow the repository's
  `evidence.reviewed_files` for the inspected sources. An interpretive or
  prospective edge does not assert that its endpoints were actually integrated.

`semantic_graph` records the curation conventions and presentation mapping.
Fork relationships remain in `lineage`; a renderer can project them separately.
