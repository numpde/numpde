"""Store vectors as a compressed numeric matrix with their resumable metadata.

Matrix rows follow the insertion order of metadata records. Float64 preserves
the saved API values exactly; loading never enables NumPy object pickles.
"""

import json
from pathlib import Path
import tempfile

import numpy as np


def read_index(path):
    with np.load(path, allow_pickle=False) as archive:
        index = json.loads(str(archive['metadata'].item()))
        vectors = archive['vectors']
        if vectors.shape != (len(index['records']), index['dimensions']):
            raise ValueError('Cannot read embedding index: vector rows or dimensions differ from the metadata.')
        for record, vector in zip(index['records'].values(), vectors):
            record['embedding'] = vector.tolist()
    return index


def save_index(path, index):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    metadata = {**index, 'records': {
        key: {field: value for field, value in record.items() if field != 'embedding'}
        for key, record in index['records'].items()
    }}
    vectors = np.asarray([record['embedding'] for record in index['records'].values()],
                         dtype=np.float64).reshape(len(index['records']), index['dimensions'])
    with tempfile.NamedTemporaryFile('wb', dir=path.parent, prefix=path.name + '.',
                                     suffix='.pending', delete=False) as handle:
        temporary = Path(handle.name)
        try:
            np.savez_compressed(handle, vectors=vectors,
                                metadata=json.dumps(metadata, ensure_ascii=False, allow_nan=False))
        except BaseException:
            temporary.unlink(missing_ok=True)
            raise
    temporary.replace(path)
