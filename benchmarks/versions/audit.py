#!/usr/bin/env python3
"""Audit saved Rust input and displayed evidence against frozen source bytes."""
import argparse
import json
from pathlib import Path
import sqlite3
from run import mixed, write


def audit(project, cases):
    with sqlite3.connect(f'file:{project}/.mimirs/index.db?mode=ro',uri=True) as db:
        db.row_factory=sqlite3.Row
        sources={row['path']:row['source'].encode() for row in db.execute('SELECT f.path,s.source FROM files f JOIN source_snapshots s ON f.id=s.file_id')}
        docs=[dict(row) for row in db.execute('SELECT f.path,d.text,d.evidence FROM retrieval_documents d JOIN files f ON f.id=d.file_id ORDER BY f.path,d.ordinal')]
    for path,source in sources.items():
        if source!=(project/path).read_bytes(): raise ValueError(f'snapshot differs: {path}')
    result=mixed.audit.audit_inputs(project,sources,docs)
    spans=0
    for case in cases:
        for hit in case['hits']:
            source=sources[hit['path']]
            for chunk in hit['chunks']:
                if not chunk['spans']: raise ValueError('displayed chunk has no evidence')
                for start,end,first,last in chunk['spans']:
                    if not 0<=start<end<=len(source): raise ValueError('invalid displayed byte range')
                    if (first,last)!=(source[:start].count(b'\n')+1,source[:end-1].count(b'\n')+1): raise ValueError('displayed line range differs')
                    if source[start:end].decode() not in chunk['text']: raise ValueError('cited bytes absent from displayed chunk')
                    spans+=1
    return {**result,'queries':len(cases),'displayed_spans_verified':spans,'answer_correctness':'not scored: legacy gold labels contain only filenames'}


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--root',type=Path,required=True)
    p.add_argument('--corpus',required=True)
    args=p.parse_args();root=args.root.resolve()
    pair=root/'results'/args.corpus/'rust'
    cases=json.loads((pair/'rust-cases.json').read_text())
    report=audit(root/'projects'/f'{args.corpus}-rust-0',cases)
    write(pair/'evidence-audit.json',report)
    print(json.dumps(report))

if __name__=='__main__': main()
