#!/usr/bin/env python3
"""Verify and summarize the isolated precision comparison."""
import argparse
import hashlib
import json
from pathlib import Path
import sqlite3
import statistics
import sys

sys.dont_write_bytecode=True
from quantized import index_data


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--experiment',type=Path,required=True)
    p.add_argument('--extension',type=Path,required=True)
    p.add_argument('--output',type=Path,required=True)
    args=p.parse_args();root=args.experiment.resolve()
    report=json.loads((root/'report.json').read_text())
    assert len(report['trials'])==9
    variants=['qdrant-f32','xenova-f32','xenova-q8']
    assert len({r['input_sha256'] for r in report['trials']})==1
    summary={'cpu_budget':3,'files':80,'documents':1251,'queries':74,'source_revision':report['source_revision'],'binary_sha256':report['binary_sha256'],'patched_source_sha256':report['patched_source_sha256'],'query_sha256':report['query_sha256'],'input_sha256':report['trials'][0]['input_sha256'],'models':report['models'],'variants':{},'guard_checks':json.loads((root/'guard-checks.json').read_text())}
    for variant in variants:
        rows=[r for r in report['trials'] if r['variant']==variant]
        assert len(rows)==3
        vector_hashes=[]
        for row in rows:
            assert row['documents']==1251
            profile=row['profile'];assert profile['complete'] and profile['counters']['embedding_worker_limit']==3
            assert profile['embedding_batch_sizes']=={'1':1251}
            folder=root/'runs'/f"{variant}-{row['repeat']}"
            text=(folder/'unchanged.stdout').read_text()
            assert 'indexed: 0 files\nunchanged: 80 files' in text
            _,vectors,_=index_data(root/'projects'/f"{variant}-{row['repeat']}",args.extension.resolve())
            vector_hashes.append(hashlib.sha256(b''.join(v.tobytes() for v in vectors)).hexdigest())
        assert len(set(vector_hashes))==1,'repeat embeddings changed'
        quality=report['quality'][variant]
        assert quality['queries']==74
        cases=json.loads((root/'runs'/f'{variant}-0/cases.json').read_text())
        summary['variants'][variant]={'fresh_seconds':{'median':statistics.median(r['fresh']['wall_seconds'] for r in rows),'min':min(r['fresh']['wall_seconds'] for r in rows),'max':max(r['fresh']['wall_seconds'] for r in rows)},'embedding_seconds_median':statistics.median(r['embedding_seconds'] for r in rows),'unchanged_seconds_median':statistics.median(r['unchanged']['wall_seconds'] for r in rows),'peak_rss_mib':max(r['fresh']['peak_rss_bytes'] for r in rows)/2**20,'cli_search_ms_median':statistics.median(c['ms'] for c in cases),'quality':{k:v for k,v in quality.items() if k!='cases'},'vector_sha256':vector_hashes[0],'drift_to_qdrant':rows[0]['drift_to_qdrant']}
    baseline=report['quality']['qdrant-f32']['cases']
    f32=report['quality']['xenova-f32']['cases']
    q8=report['quality']['xenova-q8']['cases']
    assert baseline==f32,'float32 export control rankings differ'
    assert summary['variants']['qdrant-f32']['vector_sha256']==summary['variants']['xenova-f32']['vector_sha256']
    changes=[]
    for a,b in zip(baseline,q8):
        changes.append({'query':a['query'],'expected':a['expected'],'float32_first_rank':round(1/a['rr']) if a['rr'] else None,'q8_first_rank':round(1/b['rr']) if b['rr'] else None,'rr_difference':b['rr']-a['rr'],'recall20_difference':b['recall@20']-a['recall@20'],'float32_files':a['paths'],'q8_files':b['paths']})
    summary['paired_queries']={'improved':sum(c['rr_difference']>0 for c in changes),'regressed':sum(c['rr_difference']<0 for c in changes),'tied':sum(c['rr_difference']==0 for c in changes),'first_twenty_file_rankings_changed':sum(c['float32_files']!=c['q8_files'] for c in changes),'cases':changes}
    a=summary['variants']['qdrant-f32'];b=summary['variants']['xenova-q8']
    summary['fresh_time_reduction_percent']=100*(1-b['fresh_seconds']['median']/a['fresh_seconds']['median'])
    summary['peak_rss_reduction_percent']=100*(1-b['peak_rss_mib']/a['peak_rss_mib'])
    args.output.write_text(json.dumps(summary,indent=2)+'\n')
    print(json.dumps({k:v for k,v in summary.items() if k in ['variants','fresh_time_reduction_percent','peak_rss_reduction_percent']},indent=2))

if __name__=='__main__': main()
