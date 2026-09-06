#!/usr/bin/env python3
"""Summarize completed benchmark pairs without discarding per-query results."""
import argparse
import sys
sys.dont_write_bytecode = True
import json
import math
from pathlib import Path
import statistics
from run import score, write

HERE=Path(__file__).resolve().parent


def distribution(values):
    values=sorted(values)
    return {'n':len(values),'median':statistics.median(values),'min':min(values),'max':max(values),'p95':values[math.ceil(.95*len(values))-1]}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    root=args.root.resolve(); output=args.output.resolve();output.mkdir(parents=True,exist_ok=True)
    summary={'pairs':[],'incomplete':[]}
    for corpus in ['mimirs','excalidraw','django','kubernetes']:
        manifest=json.loads((root/'corpora'/f'{corpus}.json').read_text())
        for version in ['v1','v2','rust']:
            pair=root/'results'/corpus/version
            if not (pair/'complete.json').exists():
                summary['incomplete'].append(f'{corpus}/{version}');continue
            complete=json.loads((pair/'complete.json').read_text())
            queries=json.loads((HERE/'queries'/f'{corpus}.json').read_text())
            project=root/'projects'/f'{corpus}-{version}-0'
            cases=json.loads((pair/'rust-cases.json').read_text()) if version=='rust' else json.loads((pair/'warm.json').read_text())['cases']
            quality=score(queries,cases,manifest['expected_path_corrections'],project)
            write(output/f'{corpus}-{version}-quality.json',quality)
            row={'corpus':corpus,'version':version,'files':manifest['files'],'source_bytes':manifest['bytes'],
                 'quality':{k:v for k,v in quality.items() if k!='cases'},
                 'timing':{stage:distribution([t[stage]['wall_seconds'] for t in complete['trials']]) for stage in ['fresh','unchanged','edited']},
                 'fresh_cpu_seconds':distribution([t['fresh']['user_seconds']+t['fresh']['system_seconds'] for t in complete['trials']]),
                 'fresh_peak_rss_bytes':max(t['fresh']['peak_rss_bytes'] for t in complete['trials']),
                 'database':complete['trials'][0]['database'],'edit_paths':complete['trials'][0]['edit_paths'],'raw_directory':str(pair)}
            cli=json.loads((pair/'cli.json').read_text())
            row['cli_ms']=distribution([c['wall_seconds']*1000 for c in cli])
            if version!='rust':
                warm=json.loads((pair/'warm.json').read_text())
                row['persistent_ms']=distribution([c['ms'] for c in warm['cases']])
                row['persistent_open_ms']=warm['openMs'];row['persistent_first_search_ms']=warm['firstSearchMs']
                row['ranking_changes_across_passes']=sum([h['path'] for h in c['hits']]!=[h['path'] for h in cases[c['index']]['hits']] for c in cases if c['pass']>0)
            if version != 'rust':
                from parity import check
                parity_path=pair/'cli-parity.json'
                if not parity_path.exists(): write(parity_path,check(root,corpus,version))
                parity=json.loads(parity_path.read_text())
                row['cli_api_parity']={'checks':len(parity),'mismatches':sum(not c['matches'] for c in parity)}
            else:
                from audit import audit
                audit_path=pair/'evidence-audit.json'
                if not audit_path.exists(): write(audit_path,audit(project,cases))
                row['evidence_audit']=json.loads(audit_path.read_text())
                write(output/f'{corpus}-rust-evidence.json',row['evidence_audit'])
            summary['pairs'].append(row)
    common=[c for c in ['mimirs','excalidraw','django','kubernetes'] if sum(r['corpus']==c for r in summary['pairs'])==3]
    aggregate={}
    for version in ['v1','v2','rust']:
        rows=[r for r in summary['pairs'] if r['corpus'] in common and r['version']==version]
        count=sum(r['quality']['queries'] for r in rows)
        if count:
            aggregate[version]={'queries':count,**{metric:sum(r['quality'][metric]*r['quality']['queries'] for r in rows)/count for metric in ['mrr@20','recall@5','recall@10','recall@20']},'misses@20':sum(r['quality']['misses@20'] for r in rows)}
    summary['aggregate']={'corpora':common,'engines':aggregate}
    summary['status']='complete' if not summary['incomplete'] else 'incomplete'
    write(output/'summary.json',summary)
    comparisons=[]
    for corpus in ['mimirs','excalidraw','django','kubernetes']:
        rust_path=output/f'{corpus}-rust-quality.json'
        if not rust_path.exists(): continue
        rust=json.loads(rust_path.read_text())['cases']
        for version in ['v1','v2']:
            baseline_path=output/f'{corpus}-{version}-quality.json'
            if not baseline_path.exists(): continue
            baseline=json.loads(baseline_path.read_text())['cases']
            changes=[{'query':a['query'],'expected':a['expected'],'rust_rank':round(1/a['rr']) if a['rr'] else None,'baseline_rank':round(1/b['rr']) if b['rr'] else None,'rr_difference':a['rr']-b['rr']} for a,b in zip(rust,baseline)]
            comparisons.append({'corpus':corpus,'baseline':version,'rust_wins':sum(c['rr_difference']>0 for c in changes),'rust_losses':sum(c['rr_difference']<0 for c in changes),'ties':sum(c['rr_difference']==0 for c in changes),'changes':sorted(changes,key=lambda c:c['rr_difference'])})
    write(output/'rank-comparisons.json',comparisons)
    lines=['# Three-version benchmark results','', 'Measured on the same host with cached model assets and three embedding CPUs. See ../README.md for methodology.','',
           '| Corpus | Engine | R@5 | R@10 | R@20 | MRR@20 | Misses | Fresh s | Unchanged s | Edited s | CLI median ms | Warm median ms | Peak RSS MiB | Index MiB |',
           '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|']
    for r in summary['pairs']:
        q=r['quality']; t=r['timing'];warm=f"{r['persistent_ms']['median']:.1f}" if 'persistent_ms' in r else 'N/A'
        lines.append(f"| {r['corpus']} | {r['version']} | {q['recall@5']:.3f} | {q['recall@10']:.3f} | {q['recall@20']:.3f} | {q['mrr@20']:.3f} | {q['misses@20']} | {t['fresh']['median']:.2f} | {t['unchanged']['median']:.2f} | {t['edited']['median']:.2f} | {r['cli_ms']['median']:.1f} | {warm} | {r['fresh_peak_rss_bytes']/2**20:.0f} | {r['database']['index_bytes']/2**20:.1f} |")
    lines += ['', 'Fresh/unchanged/edited values are medians of three independent trials. CPU, timing ranges, p95 values, coverage, and per-query results are in the JSON files. Warm timings exist only for the persistent TypeScript APIs. Rust file scores collapse up to 100 owner results; TypeScript requests 20 file results. These are different retrieval budgets.','']
    if summary['incomplete']: lines += ['Incomplete pairs: '+', '.join(summary['incomplete']), '']
    if aggregate:
        lines += ['## Aggregate on corpora completed by all engines','',f"Corpora: {', '.join(common)}. Metrics are weighted by query count.",'','| Engine | Queries | R@10 | MRR@20 | Misses@20 |','|---|---:|---:|---:|---:|']
        for version,a in aggregate.items():
            lines.append(f"| {version} | {a['queries']} | {a['recall@10']:.3f} | {a['mrr@20']:.3f} | {a['misses@20']} |")
        lines += ['']
    lines += ['## Validation','']
    for r in summary['pairs']:
        if 'cli_api_parity' in r:
            check=r['cli_api_parity'];lines.append(f"- {r['corpus']} {r['version']}: {check['checks']} CLI/API ranking comparisons, {check['mismatches']} mismatches.")
        else:
            a=r['evidence_audit'];lines.append(f"- {r['corpus']} Rust: complete nonblank source coverage; {a['displayed_spans_verified']:,} displayed source spans verified.")
        if r['database']['missing_files']: lines.append(f"- {r['corpus']} {r['version']}: {len(r['database']['missing_files'])} input files absent from the fresh index; paths are recorded in summary.json.")
    lines += ['','Only filenames have gold labels. Source fidelity checks do not score answer correctness. Model download time is excluded.','']
    (output/'RESULTS.md').write_text('\n'.join(lines))
    print('\n'.join(lines))

if __name__=='__main__': main()
