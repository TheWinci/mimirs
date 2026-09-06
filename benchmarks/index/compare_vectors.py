#!/usr/bin/env python3
"""Compare frozen-query cosine candidates using the experimental embeddings."""
import argparse
import array
import hashlib
import json
import math
from pathlib import Path
import sqlite3
import subprocess

HERE = Path(__file__).resolve().parent


def vectors(path):
    values = array.array('f')
    values.frombytes(path.read_bytes())
    assert len(values) % 384 == 0
    return [values[i:i+384] for i in range(0, len(values), 384)]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', type=Path, required=True)
    parser.add_argument('--single-results', type=Path, required=True)
    parser.add_argument('--parallel-results', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    out = args.output.resolve()
    out.mkdir(parents=True)
    manifest_path = HERE.parent / 'retrieval/mixed/queries.json'
    manifest = json.loads(manifest_path.read_text())
    single = json.loads((args.single_results / 'report.json').read_text())
    parallel = json.loads((args.parallel_results / 'report.json').read_text())
    assert parallel['inputs_sha256'] == single['inputs_sha256']
    db = sqlite3.connect(f'file:{args.project.resolve()}/.mimirs/index.db?mode=ro', uri=True)
    docs = db.execute('SELECT f.path,d.ordinal,d.text FROM retrieval_documents d JOIN files f ON f.id=d.file_id ORDER BY f.path,d.ordinal').fetchall()
    inputs = json.loads((args.single_results / 'batches.json').read_text())
    assert [d[2] for d in docs] == [text for batch in inputs for text in batch]
    query_inputs = out / 'queries.json'
    query_inputs.write_text(json.dumps([[c['query']] for c in manifest['cases']]) + '\n')
    baseline_command = single['runs'][0]['command']
    command = [*baseline_command[:2], str(query_inputs), '0', str(out / 'queries.bin')]
    subprocess.run(command, check=True, stdout=subprocess.DEVNULL)
    queries = vectors(out / 'queries.bin')
    selected = {'batched': args.single_results / 'default.bin', 'single': args.single_results / 'single-repeat-3.bin', 'parallel': args.parallel_results / 'parallel-repeat-3.bin'}
    report = {'query_sha256': hashlib.sha256(manifest_path.read_bytes()).hexdigest(), 'inputs_sha256': single['inputs_sha256'], 'query_command': command, 'method': 'Offline cosine ranking with deterministic path/ordinal ties. Compare top 40 and 256 document candidates; does not execute SQLite search or render results.', 'vectors_sha256': {}, 'cases': []}
    scores = {}
    for name, path in selected.items():
        values = vectors(path)
        assert len(values) == len(docs)
        report['vectors_sha256'][name] = hashlib.sha256(path.read_bytes()).hexdigest()
        norms = [math.sqrt(sum(x*x for x in v)) for v in values]
        scores[name] = []
        for query in queries:
            norm = math.sqrt(sum(x*x for x in query))
            scores[name].append([sum(x*y for x,y in zip(query, v)) / (norm*n) for v,n in zip(values,norms)])
    for qi, case in enumerate(manifest['cases']):
        baseline = scores['batched'][qi]
        order = lambda s: sorted(range(len(docs)), key=lambda i: (-s[i], docs[i][0], docs[i][1]))
        expected = order(baseline)
        row = {'id': case['id']}
        for name in ['single', 'parallel']:
            actual = order(scores[name][qi])
            row[name] = {'top_40_identical': expected[:40] == actual[:40], 'top_256_identical': expected[:256] == actual[:256], 'max_score_difference': max(abs(a-b) for a,b in zip(baseline, scores[name][qi]))}
        report['cases'].append(row)
    (out / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report['cases'], indent=2))


if __name__ == '__main__':
    main()
