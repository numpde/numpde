#!/usr/bin/env python3
"""Build resumable project embeddings from data/repos.json (requires NumPy).

Examples:
  python3 scripts/embed_projects.py --mock --index /tmp/project-embeddings.mock.npz
  python3 scripts/embed_projects.py --key-file /path/to/openai-key.txt --limit 1
  python3 scripts/embed_projects.py --key-file /path/to/openai-key.txt
  python3 scripts/embed_projects.py --refresh project:numpde/magnet

Unchanged and minor edits are skipped. --refresh forces selected project IDs;
changing model, dimensions, or provider requires a separate index file. Successful
batches are saved before the next request, and requests are never auto-retried.
Mock vectors are deterministic test data and carry a distinct provider/model.
Inputs describe project purpose, domain keywords, and substantive methods.
Names, ownership, contribution/fork boilerplate, activity metrics, URLs, generic
contexts, theme labels, and graph edges stay out of the payload.
"""

import argparse
from collections import defaultdict
from datetime import datetime, timezone
from difflib import SequenceMatcher
import hashlib
import json
import math
import os
from pathlib import Path
import sys
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from embedding_index import read_index, save_index


ROOT = Path(__file__).resolve().parents[1]
FIELDS = ('description', 'keywords', 'methods')
API_URL = 'https://api.openai.com/v1/embeddings'


def embedding_text(repo):
    """Canonicalize selected semantic fields; incidental metadata never enters the input."""
    values = {field: repo.get(field) for field in FIELDS}
    lines = []
    for field in FIELDS:
        value = values[field]
        if value is None:
            continue
        if isinstance(value, list):
            if not all(isinstance(item, str) for item in value):
                raise ValueError(f"Cannot embed {repo['id']}: {field} must contain text values.")
            value = ', '.join(sorted({' '.join(item.casefold().split()) for item in value if item.strip()}))
        elif isinstance(value, str):
            value = ' '.join(value.casefold().split())
        else:
            raise ValueError(f"Cannot embed {repo['id']}: {field} must be text or a list of text values.")
        if value:
            lines.append(field.replace('_', ' ') + ': ' + value)
    if not lines:
        raise ValueError(f"Cannot embed {repo['id']}: none of the selected semantic fields contains text.")
    text = '\n'.join(lines)
    # UTF-8 bytes conservatively bound tokens, without adding a tokenizer package.
    if len(text.encode('utf-8')) > 8000:
        raise ValueError(f"Cannot embed {repo['id']}: selected text exceeds the 8,000-byte input budget; shorten those fields.")
    return text


def fingerprint(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def similarity(original, current):
    return SequenceMatcher(None, original.split(), current.split(), autojunk=False).ratio()


def mock_embeddings(texts, dimensions):
    """Produce repeatable unit vectors without a credential or network call."""
    vectors = []
    for text in texts:
        raw = hashlib.shake_256(text.encode('utf-8')).digest(dimensions * 2)
        values = [int.from_bytes(raw[i:i + 2], 'little') / 32767.5 - 1 for i in range(0, len(raw), 2)]
        norm = math.sqrt(sum(v * v for v in values))
        vectors.append([v / norm for v in values])
    return vectors, 0


def openai_embeddings(texts, model, dimensions, key):
    body = json.dumps({'model': model, 'input': texts, 'dimensions': dimensions,
                       'encoding_format': 'float'}).encode('utf-8')
    request = Request(API_URL, data=body, headers={
        'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'})
    try:
        with urlopen(request, timeout=60) as response:
            result = json.load(response)
    except HTTPError as exc:
        reasons = {
            400: 'the API rejected the input or model parameters',
            401: 'the credential was rejected',
            403: 'access was denied',
            429: 'a rate or quota limit blocked the request',
        }
        reason = reasons.get(exc.code, 'the API could not complete the request')
        # Error bodies can echo credentials or input. Do not print them.
        raise RuntimeError(f"Embedding request returned HTTP {exc.code}: {reason}. "
                           "Earlier completed batches remain saved; no automatic retry was made.") from None
    except (URLError, TimeoutError, OSError):
        raise RuntimeError("The embedding response was not received. The request may have been processed, "
                           "so it was not retried. Earlier completed batches remain saved.") from None
    data = result.get('data', [])
    if not isinstance(data, list) or len(data) != len(texts):
        raise RuntimeError('Cannot save the embedding response: the returned vector count differs from the input count.')
    ordered = [None] * len(texts)
    for item in data:
        index = item.get('index')
        vector = item.get('embedding')
        if type(index) is not int or not 0 <= index < len(texts) or ordered[index] is not None:
            raise RuntimeError('Cannot save the embedding response: input indices are missing, repeated, or out of range.')
        if not isinstance(vector, list) or len(vector) != dimensions or not all(
                type(v) in (int, float) and math.isfinite(v) for v in vector):
            raise RuntimeError('Cannot save the embedding response: a vector has the wrong dimensions or nonfinite values.')
        if not any(vector):
            raise RuntimeError('Cannot save the embedding response: a zero vector cannot represent semantic similarity.')
        ordered[index] = vector
    return ordered, result.get('usage', {}).get('prompt_tokens', 0)


def load_index(path, provider, model, dimensions):
    if not path.exists():
        return {'schema_version': 1, 'provider': provider, 'model': model, 'dimensions': dimensions,
                'input_fields': list(FIELDS), 'records': {}}
    index = read_index(path)
    if (index.get('provider'), index.get('model'), index.get('dimensions')) != (provider, model, dimensions):
        raise ValueError('Cannot reuse this index with a different provider, model, or dimension count. '
                         'Choose a separate --index path; no embeddings have been requested.')
    if index.get('input_fields') != list(FIELDS):
        raise ValueError('Cannot reuse this index with different embedding fields. Choose a separate --index path; '
                         'no embeddings have been requested.')
    if index.get('schema_version') != 1 or not isinstance(index.get('records'), dict):
        raise ValueError('Cannot resume the embedding index: its format is not recognized.')
    for repo_id, record in index['records'].items():
        if not isinstance(record.get('input_text'), str) or record.get('input_sha256') != fingerprint(record['input_text']):
            raise ValueError(f'Cannot resume the index: saved input provenance is inconsistent for {repo_id}.')
        vector = record.get('embedding')
        if not isinstance(vector, list) or len(vector) != dimensions or not all(
                type(v) in (int, float) and math.isfinite(v) for v in vector) or not any(vector):
            raise ValueError(f'Cannot resume the index: the saved vector is unusable for {repo_id}.')
    return index


def index_projects(args, embed=None):
    inventory = json.loads(args.input.read_text())
    repos = inventory['projects']
    ids = [r['id'] for r in repos]
    if len(set(ids)) != len(ids):
        raise ValueError('Cannot index projects: stable project IDs are duplicated in the input.')
    forced = set(args.refresh)
    unknown = forced - set(ids)
    if unknown:
        raise ValueError('Cannot refresh projects absent from the input: ' + ', '.join(sorted(unknown)))
    provider = 'mock' if args.mock else 'openai'
    model = 'mock-embedding-v1' if args.mock else args.model
    dimensions = args.dimensions
    index = load_index(args.index, provider, model, dimensions)
    stats = {'indexed': 0, 'reused': 0, 'unchanged': 0, 'minor_edits': 0,
             'requests': 0, 'prompt_tokens': 0, 'pending': 0}
    pending = []
    for repo in repos:
        text = embedding_text(repo)
        digest = fingerprint(text)
        old = index['records'].get(repo['id'])
        if repo['id'] not in forced and old:
            if digest == old['input_sha256']:
                stats['unchanged'] += 1
                continue
            if similarity(old['input_text'], text) >= args.min_similarity:
                stats['minor_edits'] += 1
                continue
        pending.append((repo['id'], text, digest))
    if args.limit is not None:
        stats['pending'] = max(0, len(pending) - args.limit)
        pending = pending[:args.limit]
    print(f"{len(pending)} candidates; {stats['unchanged']} unchanged; "
          f"{stats['minor_edits']} minor edits skipped; {stats['pending']} beyond limit.", flush=True)
    if args.dry_run or not pending:
        return stats

    # Share exact content across project IDs; no approximate vector reuse.
    cached = {r['input_sha256']: r['embedding'] for r in index['records'].values()}
    groups = defaultdict(list)
    for repo_id, text, digest in pending:
        groups[digest].append((repo_id, text))
    # Explicit refresh bypasses the old exact-content cache for those documents.
    refresh_digests = {digest for repo_id, _, digest in pending if repo_id in forced}
    new_digests = [digest for digest in groups if digest not in cached or digest in refresh_digests]

    def record(digests):
        now = datetime.now(timezone.utc).isoformat()
        for digest in digests:
            for repo_id, text in groups[digest]:
                index['records'][repo_id] = {'input_text': text, 'input_sha256': digest,
                    'embedding': cached[digest], 'indexed_at': now}
                stats['indexed'] += 1
        save_index(args.index, index)

    reusable = [digest for digest in groups if digest not in new_digests]
    if reusable:
        stats['reused'] = sum(len(groups[digest]) for digest in reusable)
        record(reusable)
    if new_digests and embed is None:
        if args.mock:
            embed = lambda texts: mock_embeddings(texts, dimensions)
        else:
            key = args.key_file.read_text().strip() if args.key_file else os.environ.get('OPENAI_API_KEY', '').strip()
            if not key:
                raise ValueError('Cannot request embeddings: supply --key-file or set OPENAI_API_KEY.')
            embed = lambda texts: openai_embeddings(texts, model, dimensions, key)
    for offset in range(0, len(new_digests), args.batch_size):
        batch = new_digests[offset:offset + args.batch_size]
        vectors, tokens = embed([groups[digest][0][1] for digest in batch])
        if len(vectors) != len(batch):
            raise RuntimeError('Cannot save embeddings: the provider returned an incomplete batch.')
        cached.update(zip(batch, vectors))
        stats['requests'] += 1
        stats['prompt_tokens'] += tokens
        record(batch)
        print(f"Saved {stats['indexed']} project records; "
              f"{stats['requests']} requests; {stats['prompt_tokens']} prompt tokens.", flush=True)
    return stats


def arguments(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--input', type=Path, default=ROOT / 'data' / 'repos.json')
    parser.add_argument('--index', type=Path)
    parser.add_argument('--model', default='text-embedding-3-small')
    parser.add_argument('--dimensions', type=int, default=1536)
    parser.add_argument('--key-file', type=Path)
    parser.add_argument('--mock', action='store_true', help='Use deterministic, nonsemantic test vectors; never read credentials or call an API.')
    parser.add_argument('--min-similarity', type=float, default=.9, help='Skip edits at or above this word-sequence similarity to the saved input (default: 0.9).')
    parser.add_argument('--refresh', action='append', default=[], metavar='PROJECT_ID', help='Force a fresh embedding for this project; repeat as needed.')
    parser.add_argument('--batch-size', type=int, choices=range(1, 33), default=32)
    parser.add_argument('--limit', type=int, help='Process at most this many eligible project records.')
    parser.add_argument('--dry-run', action='store_true', help='Report candidates without reading credentials, requesting embeddings, or writing the index.')
    args = parser.parse_args(argv)
    if not 0 < args.min_similarity <= 1:
        parser.error('--min-similarity must be greater than zero and at most one')
    if args.dimensions < 1 or args.dimensions > 3072:
        parser.error('--dimensions must be between 1 and 3072')
    if args.limit is not None and args.limit < 0:
        parser.error('--limit must be nonnegative')
    if args.index is None:
        args.index = ROOT / 'data' / ('project-embeddings.mock.npz' if args.mock else 'project-embeddings.npz')
    if args.index.resolve() == args.input.resolve():
        parser.error('--index must differ from --input; repos.json remains authoritative')
    return args


def main():
    try:
        stats = index_projects(arguments())
    except (ValueError, RuntimeError, OSError) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print(json.dumps(stats, sort_keys=True))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
