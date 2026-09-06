#!/usr/bin/env python3
"""Compare pinned Mimirs engines, sequentially, on frozen source manifests."""
import argparse
import sys
sys.dont_write_bytecode = True
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import statistics
import subprocess
import time

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('mixed_check', HERE.parent / 'retrieval/mixed/check.py')
mixed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mixed)


def write(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')


def command(root, version, project, operation, query=None, rust_limit=100):
    if version == 'rust':
        return [str(root/'engines/mimirs-rust'), operation] + ([query, '--limit', str(rust_limit)] if query is not None else [])
    engine = root/'engines'/version
    if version == 'v1':
        return ['bun', str(engine/'src/main.ts'), operation] + ([query, '--top', '20', '--dir', str(project)] if query is not None else [str(project)])
    return ['bun', str(engine/'src/cli/index.ts'), operation, '-d', str(project)] + (['-q', query, '--max-results', '20'] if query is not None else [])


def measure(cmd, cwd, prefix):
    prefix.parent.mkdir(parents=True, exist_ok=True)
    env = {**os.environ, 'MIMIRS_EMBEDDING_THREADS':'3', 'NO_COLOR':'1'}
    env.pop('RAG_DB_DIR', None)
    start = time.perf_counter()
    with prefix.with_suffix('.stdout').open('w') as out, prefix.with_suffix('.stderr').open('w') as err:
        completed = subprocess.run(['/usr/bin/time', '-l', '-o', str(prefix.with_suffix('.time')), *cmd], cwd=cwd, env=env, stdout=out, stderr=err)
    wall = time.perf_counter() - start
    raw = prefix.with_suffix('.time').read_text()
    cpu = re.search(r'([\d.]+) real\s+([\d.]+) user\s+([\d.]+) sys', raw)
    rss = re.search(r'(\d+)\s+maximum resident set size', raw)
    result = {'command':cmd,'wall_seconds':wall,'exit_code':completed.returncode,
              'user_seconds':float(cpu[2]) if cpu else None,'system_seconds':float(cpu[3]) if cpu else None,
              'peak_rss_bytes':int(rss[1]) if rss else None}
    write(prefix.with_suffix('.json'), result)
    if completed.returncode:
        raise RuntimeError(f'command failed: {prefix}: {prefix.with_suffix(".stderr").read_text()[-3000:]}')
    return result


def config(project, version):
    state = project/'.mimirs'
    state.mkdir(exist_ok=True)
    common = {'include':['**/*'],'exclude':['**/.mimirs/**'],'generated':[]}
    if version == 'rust':
        (state/'config.toml').write_text('include = ["**/*"]\nexclude = ["**/.mimirs/**"]\nembedding_workers = 3\n')
    else:
        if version == 'v1': common['indexThreads'] = 3
        else: common['index'] = {'source':{'directories':[str(project.resolve())]}, 'history':{'provider':'git','directories':[]}, 'conversations':{'directories':[]}}
        write(state/'config.json', common)


def relative_path(path, project=None):
    p = Path(path)
    if p.is_absolute():
        if project is None: raise ValueError('absolute hit needs project root')
        return p.resolve().relative_to(project.resolve()).as_posix()
    if '..' in p.parts: raise ValueError('path escapes corpus')
    return p.as_posix()


def unique_paths(hits, project=None):
    return list(dict.fromkeys(relative_path(h['path'],project) for h in hits))[:20]


def score(queries, cases, corrections, project=None):
    rows = []
    for case in cases:
        if case['pass'] != 0: continue
        q = queries[case['index']]
        expected = set(corrections.get(p,p) for p in q['expected'])
        paths = unique_paths(case['hits'],project)
        ranks = [paths.index(p)+1 for p in expected if p in paths]
        rows.append({'index':case['index'],'query':q['query'],'expected':sorted(expected),'paths':paths,
                     'rr':1/min(ranks) if ranks else 0,
                     **{f'recall@{k}':len(expected.intersection(paths[:k]))/len(expected) for k in (5,10,20)}})
    assert len(rows) == len(queries)
    return {'queries':len(rows),'mrr@20':statistics.mean(r['rr'] for r in rows),
            **{f'recall@{k}':statistics.mean(r[f'recall@{k}'] for r in rows) for k in (5,10,20)},
            'misses@20':sum(r['rr']==0 for r in rows),'underfilled@20':sum(len(r['paths'])<20 for r in rows),'cases':rows}


def database_info(project, version, manifest):
    path = project/'.mimirs'/('index.sqlite' if version == 'v2' else 'index.db')
    with sqlite3.connect(f'file:{path}?mode=ro', uri=True) as db:
        tables = [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")]
        counts = {}
        for table in tables:
            if table in {'files','chunks','retrieval_documents','entities','relations','windows','semantic_vectors','fact_documents','relation_documents','source_files','source_windows','source_chunks','source_facts','source_vectors','facts','fact_vectors','relation_vectors','document_embeddings_rowids','source_window_vectors_rowids','fact_document_vectors_rowids','relation_document_vectors_rowids'}:
                counts[table] = db.execute(f'SELECT count(*) FROM "{table}"').fetchone()[0]
        indexed = {relative_path(r[0],project) for r in db.execute('SELECT path FROM files')}
    eligible = {f['path'] for f in manifest['manifest']}
    return {'counts':counts,'missing_files':sorted(eligible-indexed),'extra_files':sorted(indexed-eligible),
            'index_bytes':sum(p.stat().st_size for p in (project/'.mimirs').rglob('*') if p.is_file()),'tables':tables}


def edit_files(manifest, queries):
    corrections=manifest['expected_path_corrections']
    expected={corrections.get(p,p) for q in queries for p in q['expected']}
    return sorted((f for f in manifest['manifest'] if f['path'] in expected),key=lambda f:(-f['bytes'],f['path']))[:2]


def run_pair(args, corpus, version):
    root = args.root.resolve()
    output = root/'results'/corpus/version
    output.mkdir(parents=True, exist_ok=True)
    if (output/'complete.json').exists():
        print('SKIP complete',corpus,version,flush=True); return
    source = root/'corpora'/corpus
    manifest = json.loads((root/'corpora'/f'{corpus}.json').read_text())
    queries = json.loads((HERE/'queries'/f'{corpus}.json').read_text())
    report = {'edit_policy':'two largest files referenced by fixed query labels', 'corpus':corpus,'version':version,'manifest_sha256':manifest['manifest_sha256'],'trials':[]}
    for trial in range(args.repeats):
        trial_out = output/f'trial-{trial}'
        trial_out.mkdir(exist_ok=True)
        project = root/'projects'/f'{corpus}-{version}-{trial}'
        if project.exists(): shutil.rmtree(project)
        shutil.copytree(source, project)
        config(project,version)
        print('INDEX',corpus,version,trial,flush=True)
        fresh = measure(command(root,version,project,'index'),project,trial_out/'fresh')
        info = database_info(project,version,manifest)
        write(trial_out/'database.json',info)
        print('INDEXED',corpus,version,trial,round(fresh['wall_seconds'],2),info['counts'],'missing',len(info['missing_files']),flush=True)
        unchanged = measure(command(root,version,project,'index'),project,trial_out/'unchanged')
        # Use queried source files so encoded assets skipped by an engine cannot make an edit a no-op.
        edits = edit_files(manifest,queries)
        if len(edits)!=2 or any(e['path'] in info['missing_files'] for e in edits):
            raise RuntimeError('the fixed edit targets were not both indexed')
        for entry in edits:
            p = project/entry['path']
            marker = b'\n# mimirs benchmark incremental edit\n' if p.suffix in {'.py','.pyi'} else b'\n// mimirs benchmark incremental edit\n'
            p.write_bytes(p.read_bytes()+marker)
        changed = measure(command(root,version,project,'index'),project,trial_out/'edited')
        report['trials'].append({'trial':trial,'fresh':fresh,'unchanged':unchanged,'edited':changed,'edit_paths':[e['path'] for e in edits],'database':info})
        write(output/'progress.json',report)
        if trial == 0:
            for entry in edits: shutil.copyfile(source/entry['path'],project/entry['path'])
            measure(command(root,version,project,'index'),project,trial_out/'restore')
            print('SEARCH',corpus,version,flush=True)
            cases = []
            if version != 'rust':
                measure(['bun',str(HERE/'search.ts'),version,str(root/'engines'/version),str(project),str(HERE/'queries'/f'{corpus}.json'),str(output/'warm.json'),str(args.repeats)],project,output/'warm-process')
                cases = json.loads((output/'warm.json').read_text())['cases']
            cli = []
            # All Rust queries provide quality; fixed evenly spaced samples measure process latency for every engine.
            sample = set(round(i*(len(queries)-1)/9) for i in range(10))
            for repeat in range(args.repeats):
                for i,q in enumerate(queries):
                    if not (version == 'rust' and repeat == 0) and i not in sample: continue
                    prefix = output/'search'/f'{repeat}-{i}'
                    timing = measure(command(root,version,project,'search',q['query'],rust_limit=getattr(args,'rust_limit',100)),project,prefix)
                    if i in sample: cli.append({'repeat':repeat,'index':i,**timing})
                    if version == 'rust' and repeat == 0:
                        hits = mixed.parse(prefix.with_suffix('.stdout').read_text())
                        cases.append({'pass':0,'index':i,'ms':timing['wall_seconds']*1000,'hits':hits})
            write(output/'cli.json',cli)
            write(output/'quality.json',score(queries,cases,manifest['expected_path_corrections'],project))
            if version == 'rust': write(output/'rust-cases.json',cases)
            report['quality'] = json.loads((output/'quality.json').read_text())
        # Keep first index for reproducibility; discard other disposable copies only.
        if trial != 0: shutil.rmtree(project)
    if (output/'error.json').exists(): (output/'error.json').unlink()
    write(output/'complete.json',report)
    print('DONE',corpus,version,flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',type=Path,required=True)
    parser.add_argument('--corpora',nargs='+',default=['mimirs','excalidraw','django','kubernetes'])
    parser.add_argument('--versions',nargs='+',default=['v1','v2','rust'])
    parser.add_argument('--repeats',type=int,default=3)
    parser.add_argument('--rust-limit',type=int,default=100,help='Use 20 for the file-level retrieval port; historical owner baseline used 100')
    args = parser.parse_args()
    for corpus in args.corpora:
        for version in args.versions:
            try: run_pair(args,corpus,version)
            except Exception as error:
                output = args.root/'results'/corpus/version
                output.mkdir(parents=True,exist_ok=True)
                write(output/'error.json',{'error':str(error)})
                print('FAILED',corpus,version,str(error),flush=True)
            subprocess.run(['python3',str(HERE/'report.py'),'--root',str(args.root),'--output',str(args.root/'summary')],check=True,stdout=subprocess.DEVNULL)

if __name__ == '__main__': main()
