#!/usr/bin/env python3
"""Measure index scenarios on a pinned Maturin checkout; all writes are disposable."""
import argparse
import errno
import hashlib
import json
import os
from pathlib import Path
import platform
import pty
import shutil
import sqlite3
import statistics
import subprocess
import time

REVISION = '479658ad9bce22c6e4955b2e47182111c166e37c'
MODEL = 'models--Qdrant--all-MiniLM-L6-v2-onnx'
EDITS = {'src/lib.rs': '\n// profiling incremental marker rust\n', 'maturin/__init__.py': '\n# profiling incremental marker python\n'}


def fingerprint(root):
    db = sqlite3.connect(f'file:{root}/.mimirs/index.db?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    docs = [dict(r) for r in db.execute('SELECT f.path,d.owner,d.part,d.text,d.evidence FROM retrieval_documents d JOIN files f ON f.id=d.file_id ORDER BY f.path,d.ordinal')]
    content = hashlib.sha256()
    for table in ['source_snapshots', 'entities', 'analysis_records', 'retrieval_documents', 'retrieval_processing', 'document_embeddings_chunks', 'document_embeddings_rowids', 'document_embeddings_vector_chunks00']:
        rows = sorted(repr(tuple(row)) for row in db.execute('SELECT * FROM ' + table))
        content.update(table.encode() + '\n'.join(rows).encode())
    result = {'documents': len(docs), 'documents_sha256': hashlib.sha256(json.dumps(docs, sort_keys=True).encode()).hexdigest(), 'saved_content_sha256': content.hexdigest()}
    db.close()
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--project', type=Path, required=True)
    parser.add_argument('--cache', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--repeats', type=int, default=3)
    args = parser.parse_args()
    assert args.repeats >= 3
    binary, project, output = args.binary.resolve(), args.project.resolve(), args.output.resolve()
    assert not output.exists(), 'use a new output directory'
    assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=project, text=True).strip() == REVISION
    subprocess.run(['git', 'diff', '--exit-code', 'HEAD'], cwd=project, check=True, stdout=subprocess.DEVNULL)
    output.mkdir(parents=True)
    root = output / 'project'
    (root / '.mimirs').mkdir(parents=True)
    config = (project / '.mimirs/config.toml').read_text()
    assert '"/target/**"' in config and '"**/target/**"' not in config
    (root / '.mimirs/config.toml').write_text(config)
    tracked = subprocess.check_output(['git', 'ls-files'], cwd=project, text=True).splitlines()
    corpus_hash = hashlib.sha256()
    for file in sorted(p for p in tracked if Path(p).suffix in {'.py', '.pyi', '.rs'}):
        dest = root / file
        dest.parent.mkdir(parents=True, exist_ok=True)
        data = (project / file).read_bytes()
        dest.write_bytes(data)
        corpus_hash.update(file.encode() + b'\0' + data)
    cache = output / 'cached-model'
    shutil.copytree(args.cache.resolve() / MODEL, cache / MODEL)
    sources = {p: (root / p).read_bytes() for p in EDITS}
    metadata = {'revision': REVISION, 'binary_sha256': hashlib.sha256(binary.read_bytes()).hexdigest(), 'binary': str(binary), 'platform': platform.platform(), 'machine': platform.machine(), 'processor': platform.processor(), 'logical_cpus': os.cpu_count(), 'config': config, 'corpus_sha256': corpus_hash.hexdigest(), 'edits': EDITS, 'repeats': args.repeats, 'runs': []}
    if platform.system() == 'Darwin':
        metadata['hardware'] = subprocess.check_output(['sysctl', '-n', 'machdep.cpu.brand_string', 'hw.memsize'], text=True).splitlines()
    metadata['model_files_sha256'] = {str(p.relative_to(cache)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(cache.rglob('*')) if p.is_file() and '/snapshots/' in str(p)}
    db = root / '.mimirs/index.db'
    baseline = output / 'baseline.db'
    expected = {}

    def run(name, scenario, profiled=True, terminal=False, cold=False):
        if scenario == 'fresh':
            db.unlink(missing_ok=True)
        else:
            shutil.copy2(baseline, db)
        for p, data in sources.items():
            (root / p).write_bytes(data + (EDITS[p].encode() if scenario == 'incremental' else b''))
        command = [str(binary), 'index', '--model-cache', str(output / 'empty-model' if cold else cache)]
        if profiled:
            command.extend(['--profile', str(output / (name + '.json'))])
        start = time.monotonic()
        with (output / (name + '.stdout')).open('wb') as stdout, (output / (name + '.stderr')).open('wb') as stderr:
            if terminal:
                master, slave = pty.openpty()
                proc = subprocess.Popen(command, cwd=root, stdout=stdout, stderr=slave)
                os.close(slave)
                try:
                    while True:
                        try:
                            data = os.read(master, 65536)
                        except OSError as error:
                            if error.errno == errno.EIO:
                                break
                            raise
                        if not data:
                            break
                        stderr.write(data)
                finally:
                    os.close(master)
                code = proc.wait()
            else:
                code = subprocess.run(command, cwd=root, stdout=stdout, stderr=stderr).returncode
        elapsed = time.monotonic() - start
        assert code == 0, (name, code)
        state = fingerprint(root)
        content_group = 'incremental' if scenario == 'incremental' else 'baseline'
        if content_group in expected:
            assert state == expected[content_group], (name, 'saved content changed')
        else:
            expected[content_group] = state
        row = {'name': name, 'scenario': scenario, 'profiled': profiled, 'terminal': terminal, 'cold_model_cache': cold, 'process_seconds': elapsed, 'state': state, 'command': command}
        if profiled:
            report = json.loads((output / (name + '.json')).read_text())
            assert report['complete']
            assert report['counters']['files_read'] == 272
            if scenario == 'unchanged':
                assert report['counters'].get('embedding_calls', 0) == 0
                assert report['counters']['files_reused'] == 272
            elif scenario == 'incremental':
                assert report['counters']['files_indexed'] == 2
                assert report['counters']['files_reused'] == 270
            else:
                assert report['counters']['files_indexed'] == 272
            row['timing'] = {k: v for k, v in report.items() if k != 'files'}
        metadata['runs'].append(row)
        (output / 'report.json').write_text(json.dumps(metadata, indent=2) + '\n')
        print(name, round(elapsed, 3), state['documents'], flush=True)

    for i in range(args.repeats):
        # Alternate ordering to reduce bias from temperature or background work.
        for profiled in ([True, False] if i % 2 == 0 else [False, True]):
            run(f'fresh-{i+1}-' + ('profile' if profiled else 'plain'), 'fresh', profiled)
            if not baseline.exists():
                shutil.copy2(db, baseline)
        run(f'unchanged-{i+1}', 'unchanged')
        run(f'incremental-{i+1}', 'incremental')
        run(f'terminal-unchanged-{i+1}', 'unchanged', terminal=True)
        run(f'terminal-incremental-{i+1}', 'incremental', terminal=True)
    run('terminal-fresh', 'fresh', terminal=True)
    run('cold-first-index', 'fresh', cold=True)
    groups = {}
    for row in metadata['runs']:
        group = f"{row['scenario']}/{'profile' if row['profiled'] else 'plain'}/{'tty' if row['terminal'] else 'redirected'}/{'cold' if row['cold_model_cache'] else 'cached'}"
        groups.setdefault(group, []).append(row['process_seconds'])
    metadata['summary'] = {k: {'runs': len(v), 'median_seconds': statistics.median(v), 'min_seconds': min(v), 'max_seconds': max(v)} for k, v in groups.items()}
    (output / 'report.json').write_text(json.dumps(metadata, indent=2) + '\n')
    print(json.dumps(metadata['summary'], indent=2))


if __name__ == '__main__':
    main()
