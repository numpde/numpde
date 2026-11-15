"""Exercise billing-sensitive cache behavior without contacting OpenAI."""

from contextlib import redirect_stdout
from io import BytesIO, StringIO
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import embed_projects as embeddings


def repo(number):
    return {'id': f'project:example/repo-{number}', 'description': f'Scientific investigation of task {number}.',
            'keywords': ['prediction', 'experiments']}


class EmbeddingIndexTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.input = self.root / 'repos.json'
        self.index = self.root / 'embeddings.npz'

    def write(self, repos, themes=None):
        self.input.write_text(json.dumps({'projects': repos}))

    def args(self, *extra):
        return embeddings.arguments(['--input', str(self.input), '--index', str(self.index),
                                     '--mock', '--dimensions', '8', *extra])

    def run_index(self, args=None, embed=None):
        with redirect_stdout(StringIO()):
            return embeddings.index_projects(args or self.args(), embed=embed)

    def saved(self):
        return embeddings.read_index(self.index)

    def test_incremental_additions_and_irrelevant_changes_cost_nothing(self):
        a, b = repo(1), repo(2)
        self.write([a, b])
        self.assertEqual(self.run_index()['requests'], 1)
        original = self.index.read_bytes()
        a['commit_count'] = 999
        a['full_name'] = 'incidental/renamed'
        a['url'] = 'https://example.invalid/renamed'
        a['visibility'] = 'private'
        a['links'] = ['incidental connection']
        a['categories'] = ['local-only-category']
        a['keywords'].reverse()
        b['description'] = '  SCIENTIFIC   investigation of task 2. '
        self.write([a, b])
        self.assertEqual(self.run_index()['requests'], 0)
        self.assertEqual(self.index.read_bytes(), original)
        self.write([a, b, repo(3)])
        stats = self.run_index()
        self.assertEqual((stats['indexed'], stats['unchanged']), (1, 2))
        self.assertEqual(len(self.saved()['records']), 3)

    def test_project_meaning_excludes_contribution_boilerplate(self):
        a = repo(1)
        a.update(methods='Infer molecular structure using constrained sequence decoding.',
                 work_summary='Reference fork; no personal implementation commits.',
                 work_keywords=['upstream maintenance'], theme_ids=['opaque-id'],
                 work_contexts=['reference'], repository_ids=['github:example/reference'])
        text = embeddings.embedding_text(a)
        self.assertIn('constrained sequence decoding', text)
        for incidental in ('reference fork', 'upstream maintenance', 'opaque-id', 'github:example'):
            self.assertNotIn(incidental, text)
        self.write([a])
        self.run_index()
        a['methods'] = 'Track forest navigation using noisy GPS paths and belief distributions.'
        self.write([a])
        self.assertEqual(self.run_index()['indexed'], 1)
        self.assertIn('forest navigation', self.saved()['records'][a['id']]['input_text'])

    def test_changed_field_contract_cannot_silently_reuse_an_old_index(self):
        self.write([repo(1)])
        self.run_index()
        saved = self.saved()
        saved['input_fields'] = ['description', 'work_summary', 'keywords', 'work_keywords', 'themes', 'work_contexts']
        embeddings.save_index(self.index, saved)
        with self.assertRaisesRegex(ValueError, 'different embedding fields'):
            self.run_index()

    def test_minor_edits_keep_the_original_comparison_anchor(self):
        a = repo(1)
        a['description'] = ' '.join('term' + str(i) for i in range(40))
        self.write([a])
        self.run_index()
        original = self.index.read_bytes()
        a['description'] += ' a small clarification'
        self.write([a])
        self.assertEqual(self.run_index()['minor_edits'], 1)
        self.assertEqual(self.index.read_bytes(), original)
        a['description'] = 'A completely different research question about rights and permissions.'
        self.write([a])
        self.assertEqual(self.run_index()['requests'], 1)

    def test_identical_documents_reuse_vectors_across_ids(self):
        a, b = repo(1), repo(1)
        b['id'] = 'project:another/copy'
        self.write([a, b])
        calls = []

        def fake(texts):
            calls.append(texts)
            return embeddings.mock_embeddings(texts, 8)

        self.run_index(embed=fake)
        self.assertEqual(len(calls[0]), 1)
        c = dict(a, id='project:third/copy')
        self.write([a, b, c])
        # Reusing an already paid-for vector does not even need a key file.
        args = self.args('--key-file', str(self.root / 'absent-key'))
        self.assertEqual(self.run_index(args)['reused'], 1)
        self.assertEqual(len(self.saved()['records']), 3)

    def test_successful_batches_survive_a_later_failure(self):
        self.write([repo(1), repo(2), repo(3)])
        calls = 0

        def fail_second_batch(texts):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise RuntimeError('mock outage')
            return embeddings.mock_embeddings(texts, 8)

        with self.assertRaisesRegex(RuntimeError, 'mock outage'):
            self.run_index(self.args('--batch-size', '2'), fail_second_batch)
        self.assertEqual(len(self.saved()['records']), 2)
        stats = self.run_index()
        self.assertEqual((stats['indexed'], stats['unchanged']), (1, 2))

    def test_explicit_refresh_and_model_separation(self):
        self.write([repo(1), repo(2)])
        self.run_index()
        stats = self.run_index(self.args('--refresh', 'project:example/repo-1'))
        self.assertEqual((stats['indexed'], stats['requests']), (1, 1))
        before = self.index.read_bytes()
        with self.assertRaisesRegex(ValueError, 'different provider, model, or dimension'):
            self.run_index(self.args('--dimensions', '12'))
        live = self.args()
        live.mock = False
        with self.assertRaisesRegex(ValueError, 'different provider, model, or dimension'):
            self.run_index(live)
        self.assertEqual(self.index.read_bytes(), before)

    def test_mock_and_dry_run_never_use_the_network(self):
        self.write([repo(1)])
        with patch.object(embeddings, 'urlopen', side_effect=AssertionError('network called')):
            self.run_index(self.args('--dry-run', '--key-file', str(self.root / 'absent')))
            self.assertFalse(self.index.exists())
            self.run_index(self.args('--key-file', str(self.root / 'absent')))

    def test_response_indices_and_key_redaction(self):
        result = {'data': [{'index': 1, 'embedding': [0, 1]},
                           {'index': 0, 'embedding': [1, 0]}], 'usage': {'prompt_tokens': 7}}
        with patch.object(embeddings, 'urlopen', return_value=BytesIO(json.dumps(result).encode())):
            vectors, tokens = embeddings.openai_embeddings(['first', 'second'], 'model', 2, 'test-secret')
        self.assertEqual(vectors, [[1, 0], [0, 1]])
        self.assertEqual(tokens, 7)
        error = HTTPError(embeddings.API_URL, 401, 'test-secret echoed by server', {},
                          BytesIO(b'{"error":{"message":"test-secret"}}'))
        with patch.object(embeddings, 'urlopen', side_effect=error):
            with self.assertRaises(RuntimeError) as caught:
                embeddings.openai_embeddings(['first'], 'model', 2, 'test-secret')
        self.assertIn('401', str(caught.exception))
        self.assertNotIn('test-secret', str(caught.exception))


if __name__ == '__main__':
    unittest.main()
