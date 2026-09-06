#!/usr/bin/env python3
"""Measure persistent single-chunk workers without crossing file boundaries."""
import argparse
import array
import hashlib
import json
import math
import os
from pathlib import Path
import resource
import shutil
import statistics
import subprocess
import time

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--single-results', type=Path, required=True)
    parser.add_argument('--snapshot', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--cpu-budget', action='store_true', help='Compare one-third and one-half of available CPUs, one thread per worker, three runs each')
    args = parser.parse_args()
    out = args.output.resolve()
    out.mkdir(parents=True)
    source = out / 'crate'
    source.mkdir()
    shutil.copy2(HERE / 'parallel_probe.rs', source / 'main.rs')
    manifest = (args.single_results / 'crate/Cargo.toml').read_text().replace('mimirs-embedding-probe', 'mimirs-parallel-embedding-probe')
    (source / 'Cargo.toml').write_text(manifest)
    shutil.copy2(REPO / 'Cargo.lock', source / 'Cargo.lock')
    subprocess.run(['cargo', 'build', '--release', '--offline', '--manifest-path', str(source / 'Cargo.toml'), '--target-dir', str(REPO / 'target')], check=True)
    binary = REPO / 'target/release/mimirs-parallel-embedding-probe'
    inputs = out / 'batches.json'
    shutil.copy2(args.single_results / 'batches.json', inputs)
    baseline = json.loads((args.single_results / 'report.json').read_text())
    reference = array.array('f')
    reference.frombytes((args.single_results / 'default.bin').read_bytes())
    available_cpus = os.cpu_count() or 1
    environment = os.environ.copy()
    if args.cpu_budget:
        environment['TOKENIZERS_PARALLELISM'] = 'false'
    report = {'binary_sha256': hashlib.sha256(binary.read_bytes()).hexdigest(), 'source_sha256': hashlib.sha256((source / 'main.rs').read_bytes()).hexdigest(), 'inputs_sha256': hashlib.sha256(inputs.read_bytes()).hexdigest(), 'baseline_vectors_sha256': hashlib.sha256(reference.tobytes()).hexdigest(), 'available_cpus': available_cpus, 'cpu_budget_mode': args.cpu_budget, 'tokenizers_parallelism': environment.get('TOKENIZERS_PARALLELISM'), 'runs': []}
    assert report['inputs_sha256'] == baseline['inputs_sha256']
    timeout = max(180, baseline['runs'][0]['embedding_seconds'] * 2)

    def run(workers, threads, label):
        vectors = out / (label + '.bin')
        command = [str(binary), str(args.snapshot.resolve()), str(inputs), str(threads), str(vectors), str(workers)]
        print('starting', label, flush=True)
        usage_before = resource.getrusage(resource.RUSAGE_CHILDREN)
        started = time.perf_counter()
        with (out / (label + '.stdout')).open('wb') as output:
            try:
                subprocess.run(command, stdout=output, check=True, timeout=timeout, env=environment)
            except subprocess.TimeoutExpired:
                row = {'label': label, 'workers': workers, 'threads_per_worker': threads, 'status': 'timeout', 'process_seconds_lower_bound': timeout, 'command': command}
                report['runs'].append(row)
                (out / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
                print(label, 'exceeded', timeout, 'seconds', flush=True)
                return
        elapsed = time.perf_counter() - started
        usage_after = resource.getrusage(resource.RUSAGE_CHILDREN)
        cpu_seconds = usage_after.ru_utime + usage_after.ru_stime - usage_before.ru_utime - usage_before.ru_stime
        row = json.loads((out / (label + '.stdout')).read_text())
        values = array.array('f')
        values.frombytes(vectors.read_bytes())
        assert len(values) == len(reference)
        assert all(math.isfinite(x) for x in values)
        cosines = []
        for i in range(0, len(values), 384):
            a, b = reference[i:i+384], values[i:i+384]
            cosines.append(sum(x*y for x,y in zip(a,b)) / math.sqrt(sum(x*x for x in a) * sum(x*x for x in b)))
        row.update({'label': label, 'command': command, 'process_seconds': elapsed, 'process_cpu_seconds': cpu_seconds, 'average_busy_cores': cpu_seconds / elapsed, 'average_machine_cpu_percent': cpu_seconds / elapsed / available_cpus * 100, 'max_component_difference': max(abs(a-b) for a,b in zip(reference, values)), 'minimum_cosine_to_batched': min(cosines), 'vectors_sha256': hashlib.sha256(vectors.read_bytes()).hexdigest()})
        report['runs'].append(row)
        (out / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
        print(label, row['embedding_seconds'], row['max_component_difference'], flush=True)

    if args.cpu_budget:
        budgets = list(dict.fromkeys([max(1, available_cpus // 3), max(1, available_cpus // 2)]))
        for repetition in range(1, 4):
            for workers in budgets if repetition % 2 else reversed(budgets):
                run(workers, 1, f'budget-{workers}-repeat-{repetition}')
        report['confirmation'] = []
        for workers in budgets:
            rows = [r for r in report['runs'] if r['workers'] == workers and 'embedding_seconds' in r]
            if not rows:
                continue
            times = [r['embedding_seconds'] for r in rows]
            report['confirmation'].append({'workers': workers, 'threads_per_worker': 1, 'runs': len(rows), 'median_seconds': statistics.median(times), 'min_seconds': min(times), 'max_seconds': max(times), 'median_average_busy_cores': statistics.median(r['average_busy_cores'] for r in rows), 'median_average_machine_cpu_percent': statistics.median(r['average_machine_cpu_percent'] for r in rows)})
        (out / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps(report['confirmation'], indent=2), flush=True)
        return

    # One-worker control exercises the same queues and barrier implementation.
    best_single = baseline['confirmation']['selected_threads']
    run(1, best_single, 'worker-control')
    # The single-session sweep already covers low thread budgets. Compare
    # parallel layouts using six to ten inference threads in total.
    for workers, threads in [(2, 4), (4, 2), (6, 1), (10, 1)]:
        run(workers, threads, f'workers-{workers}-threads-{threads}')
    completed = [r for r in report['runs'] if r['workers'] > 1 and 'embedding_seconds' in r]
    if not completed:
        raise RuntimeError('No parallel trial completed')
    best = min(completed, key=lambda r: r['embedding_seconds'])
    run(best['workers'], best['threads_per_worker'], 'parallel-repeat-2')
    run(best['workers'], best['threads_per_worker'], 'parallel-repeat-3')
    times = [r['embedding_seconds'] for r in report['runs'] if r['workers'] == best['workers'] and r['threads_per_worker'] == best['threads_per_worker'] and 'embedding_seconds' in r]
    report['confirmation'] = {'workers': best['workers'], 'threads_per_worker': best['threads_per_worker'], 'runs': len(times), 'median_seconds': statistics.median(times), 'min_seconds': min(times), 'max_seconds': max(times)}
    (out / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report['confirmation'], indent=2), flush=True)


if __name__ == '__main__':
    main()
