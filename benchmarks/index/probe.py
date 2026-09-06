#!/usr/bin/env python3
"""Isolate existing embedding batches and compare ONNX thread counts, without changing mimirs."""
import argparse
import array
import hashlib
import itertools
import json
from pathlib import Path
import shutil
import sqlite3
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
    report = {'binary_sha256': hashlib.sha256(binary.read_bytes()).hexdigest(), 'source_sha256': hashlib.sha256((source / 'main.rs').read_bytes()).hexdigest(), 'inputs_sha256': hashlib.sha256(inputs.read_bytes()).hexdigest(), 'runs': []}
    if args.resume:
        previous = json.loads((out / 'report.json').read_text())
        assert all(previous[k] == report[k] for k in ['binary_sha256', 'source_sha256', 'inputs_sha256'])
        report = previous
    reference = None
    def run(threads, label, sample=False):
        nonlocal reference
        vector_file = out / (label + '.bin')
        if any(r['label'] == label for r in report['runs']):
            if label == 'default':
                reference = array.array('f'); reference.frombytes(vector_file.read_bytes())
            return
        command = [str(binary), str(args.snapshot.resolve()), str(inputs), str(threads), str(vector_file)]
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
        row = json.loads((out / (label + '.stdout')).read_text())
        values = array.array('f')
        values.frombytes(vector_file.read_bytes())
        if reference is None:
            reference = values
        assert len(values) == len(reference)
        row.update({'label': label, 'sampled': sample, 'command': command, 'max_component_difference': max(abs(a-b) for a,b in zip(reference, values)), 'vectors_sha256': hashlib.sha256(vector_file.read_bytes()).hexdigest()})
        report['runs'].append(row)
        (out / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
        print(label, row['embedding_seconds'], row['max_component_difference'], flush=True)
    run(0, 'default')
    run(1, 'threads-1')
    run(4, 'threads-4')
    if args.sample:
        run(0, 'default-sampled', sample=True)


if __name__ == '__main__':
    main()
