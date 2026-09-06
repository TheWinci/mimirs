#!/usr/bin/env python3
"""Score the frozen mixed-project queries against an already indexed checkout."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import sqlite3
import subprocess
import sys

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('audit', HERE.parent / 'compare.py')
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


def parse(stdout):
    hits = []
    for block in re.split(r'\nresult: \d+/\d+\n', stdout)[1:]:
        header = block.split('\ntext: ', 1)[0].split('\nchunk: ', 1)[0]
        path = re.search(r'^location: (.*):\d+(?:-\d+)?$', header, re.M)[1]
        owner = re.search(r'^owner: (.*)$', header, re.M)[1]
        fragments = re.split(r'\nchunk: [^\n]+\n', block)[1:] if re.search(r'^chunk: ', block, re.M) else [block]
        chunks = []
        for fragment in fragments:
            meta, text = fragment.split('\ntext: ', 1)
            text = re.sub(r'\n---\n\s*$', '', text)
            spans = [tuple(map(int, m)) for m in re.findall(r'evidence: Source bytes (\d+)\.\.(\d+) lines (\d+)\.\.(\d+)', meta)]
            chunks.append({'text': text, 'spans': spans})
        hits.append({'rank': len(hits) + 1, 'path': path, 'owner': None if owner == 'file' else int(owner[1:]), 'chunks': chunks})
    return hits


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--project', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    root, binary, output = args.project.resolve(), args.binary.resolve(), args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    manifest = json.loads((HERE / 'queries.json').read_text())
    revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
    assert revision == manifest['revision'], 'wrong corpus revision'
    db = sqlite3.connect(f'file:{root}/.mimirs/index.db?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    sources = {r['path']: r['source'].encode() for r in db.execute('SELECT f.path,s.source FROM files f JOIN source_snapshots s ON f.id=s.file_id')}
    entities = [dict(r) for r in db.execute('SELECT f.path,e.* FROM files f JOIN entities e ON f.id=e.file_id')]
    docs = [dict(r) for r in db.execute('SELECT f.path,d.owner,d.part,d.text,d.evidence FROM retrieval_documents d JOIN files f ON f.id=d.file_id ORDER BY f.path,d.ordinal')]
    assert all((root / p).read_bytes() == source for p, source in sources.items())
    tracked = subprocess.check_output(['git', 'ls-files'], cwd=root, text=True).splitlines()
    eligible = {p for p in tracked if Path(p).suffix in {'.rs', '.py', '.pyi'}}
    report = {'revision': revision, 'binary_sha256': hashlib.sha256(binary.read_bytes()).hexdigest(), 'query_sha256': hashlib.sha256((HERE / 'queries.json').read_bytes()).hexdigest(), 'documents_sha256': hashlib.sha256(json.dumps(docs, sort_keys=True).encode()).hexdigest(), 'config': (root / '.mimirs/config.toml').read_text(), 'metadata': dict(db.execute('SELECT key,value FROM index_metadata')), 'audit': audit.audit_inputs(root, sources, docs), 'excluded_sources': sorted(eligible - sources.keys()), 'cases': []}
    for case, limit in [(c, 10) for c in manifest['cases']] + [(next(c for c in manifest['cases'] if c['id'] == 'R7'), 64)]:
        raw = subprocess.check_output([str(binary), 'search', case['query'], '--limit', str(limit)], cwd=root, text=True)
        (output / f"{case['id']}-{limit}.txt").write_text(raw)
        hits = parse(raw)
        for hit in hits:
            source = sources[hit['path']]
            for chunk in hit['chunks']:
                for start, end, first, last in chunk['spans']:
                    fragment = source[start:end].decode()
                    assert 0 <= start < end <= len(source)
                    assert (first, last) == (source[:start].count(b'\n') + 1, source[:end-1].count(b'\n') + 1)
                    assert fragment in chunk['text'], 'cited source is absent from its displayed chunk'
        targets = []
        for target in case['targets']:
            owners = [e for e in entities if e['path'] == target['path'] and e['name'] == target['name']]
            assert len(owners) <= 1
            hit = next((h for h in hits if owners and h['path'] == target['path'] and h['owner'] == owners[0]['ordinal']), None)
            targets.append({**target, 'rank': hit['rank'] if hit else None, 'visible_answer': bool(hit) and all(any(s in c['text'] for c in hit['chunks']) for s in target['required_snippets']), 'displayed_parts': len(hit['chunks']) if hit else 0})
        report['cases'].append({'id': case['id'], 'group': case['group'], 'limit': limit, 'targets': targets})
    (output / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({c['id'] + '-' + str(c['limit']): [(t['name'], t['rank'], t['visible_answer']) for t in c['targets']] for c in report['cases']}, indent=2))


if __name__ == '__main__':
    main()
