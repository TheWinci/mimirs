#!/usr/bin/env python3
"""Isolate existing embedding batches and compare ONNX thread counts, without changing mimirs."""
import argparse
import array
import hashlib
import itertools
import json
import math
from pathlib import Path
import shutil
import sqlite3
import statistics
import subprocess
import time

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', type=Path, required=True)
    parser.add_argument('--snapshot', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--sample', action='store_true', help='Take a separate macOS stack sample of the default-thread run')
    parser.add_argument('--resume', action='store_true', help='Resume an unchanged experiment directory after an interrupted trial')
    parser.add_argument('--single-chunks', action='store_true', help='Compare one chunk per call at 1, 2, 4, 6, 8 and 10 threads, then repeat the fastest and baseline twice')
    args = parser.parse_args()
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=args.resume)
    source = out / 'crate'
    source.mkdir(exist_ok=args.resume)
    shutil.copy2(HERE / 'embedding_probe.rs', source / 'main.rs')
    (source / 'Cargo.toml').write_text('''[package]
name = "mimirs-embedding-probe"
version = "0.0.0"
edition = "2024"
[[bin]]
name = "mimirs-embedding-probe"
path = "main.rs"
[dependencies]
fastembed = { version = "=6.0.2", default-features = false, features = ["hf-hub-rustls-tls", "ort-download-binaries-rustls-tls"] }
serde_json = "=1.0.151"
''')
    shutil.copy2(REPO / 'Cargo.lock', source / 'Cargo.lock')
    subprocess.run(['cargo', 'build', '--release', '--offline', '--manifest-path', str(source / 'Cargo.toml'), '--target-dir', str(REPO / 'target')], check=True)
    binary = REPO / 'target/release/mimirs-embedding-probe'
    db = sqlite3.connect(f'file:{args.project.resolve()}/.mimirs/index.db?mode=ro', uri=True)
    rows = db.execute('SELECT f.path,d.text FROM retrieval_documents d JOIN files f ON f.id=d.file_id ORDER BY f.path,d.ordinal').fetchall()
    batches = []
    for _, group in itertools.groupby(rows, key=lambda r: r[0]):
        texts = [r[1] for r in group]
        batches.extend(texts[i:i+256] for i in range(0, len(texts), 256))
    inputs = out / 'batches.json'
    inputs.write_text(json.dumps(batches) + '\n')
    single_inputs = out / 'single-chunks.json'
    single_inputs.write_text(json.dumps([[text] for batch in batches for text in batch]) + '\n')
    report = {'binary_sha256': hashlib.sha256(binary.read_bytes()).hexdigest(), 'source_sha256': hashlib.sha256((source / 'main.rs').read_bytes()).hexdigest(), 'inputs_sha256': hashlib.sha256(inputs.read_bytes()).hexdigest(), 'single_chunks': args.single_chunks, 'runs': []}
    if args.resume:
        previous = json.loads((out / 'report.json').read_text())
        assert all(previous[k] == report[k] for k in ['binary_sha256', 'source_sha256', 'inputs_sha256'])
        assert previous.get('single_chunks', False) == args.single_chunks
        report = previous
    reference = None
    def run(threads, label, sample=False, single=False):
        nonlocal reference
        vector_file = out / (label + '.bin')
        if any(r['label'] == label for r in report['runs']):
            if label == 'default':
                reference = array.array('f'); reference.frombytes(vector_file.read_bytes())
            return
        command = [str(binary), str(args.snapshot.resolve()), str(single_inputs if single else inputs), str(threads), str(vector_file)]
        print('starting', label, flush=True)
        started = time.perf_counter()
        with (out / (label + '.stdout')).open('wb') as output:
            proc = subprocess.Popen(command, stdout=output)
            if sample:
                time.sleep(5)
                subprocess.run(['sample', str(proc.pid), '5', '10', '-file', str(out / 'sample.txt')], check=True)
            timeout = max(180, report['runs'][0]['embedding_seconds'] * 2) if report['runs'] and not sample else None
            try:
                assert proc.wait(timeout=timeout) == 0
            except subprocess.TimeoutExpired:
                proc.terminate(); proc.wait()
                report['runs'].append({'label':label, 'threads':threads, 'sampled':False, 'status':'timeout', 'process_seconds_lower_bound':timeout, 'command':command})
                (out / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
                print(label, 'exceeded', timeout, 'seconds', flush=True)
                return
        process_seconds = time.perf_counter() - started
        row = json.loads((out / (label + '.stdout')).read_text())
        values = array.array('f')
        values.frombytes(vector_file.read_bytes())
        if reference is None:
            reference = values
        assert len(values) == len(reference)
        assert all(math.isfinite(x) for x in values)
        cosines = []
        for i in range(0, len(values), 384):
            a, b = reference[i:i+384], values[i:i+384]
            cosines.append(sum(x*y for x,y in zip(a,b)) / math.sqrt(sum(x*x for x in a) * sum(x*x for x in b)))
        row.update({'label': label, 'sampled': sample, 'single_chunk_per_call': single, 'process_seconds': process_seconds, 'command': command, 'max_component_difference': max(abs(a-b) for a,b in zip(reference, values)), 'minimum_cosine_to_batched': min(cosines), 'vectors_sha256': hashlib.sha256(vector_file.read_bytes()).hexdigest()})
        report['runs'].append(row)
        (out / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
        print(label, row['embedding_seconds'], row['max_component_difference'], flush=True)
    run(0, 'default')
    if args.single_chunks:
        for threads in [10, 1, 2, 4, 6, 8]:
            run(threads, f'single-threads-{threads}', single=True)
        completed = [r for r in report['runs'] if r.get('single_chunk_per_call') and 'embedding_seconds' in r]
        if not completed:
            raise RuntimeError('No single-chunk trial completed within the timeout')
        best = min(completed, key=lambda r: r['embedding_seconds'])['threads']
        # Alternate order to reduce drift bias; confirmation includes the screening run.
        run(best, 'single-repeat-2', single=True)
        run(0, 'default-repeat-2')
        run(0, 'default-repeat-3')
        run(best, 'single-repeat-3', single=True)
        report['confirmation'] = {'selected_threads': best}
        for name, selected in [('batched', [r for r in report['runs'] if r['label'].startswith('default')]), ('single', [r for r in report['runs'] if r.get('single_chunk_per_call') and r['threads'] == best])]:
            times = [r['embedding_seconds'] for r in selected if 'embedding_seconds' in r]
            report['confirmation'][name] = {'runs': len(times), 'median_seconds': statistics.median(times), 'min_seconds': min(times), 'max_seconds': max(times)}
        (out / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps(report['confirmation'], indent=2), flush=True)
        return
    run(1, 'threads-1')
    run(4, 'threads-4')
    if args.sample:
        run(0, 'default-sampled', sample=True)


if __name__ == '__main__':
    main()
