#!/usr/bin/env python3
"""Replay real token tensors through pinned ONNX Runtime with threading/batch sweeps."""
import argparse
import array
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import re
import shutil
import signal
import statistics
import subprocess
import time

TEST = 'embedding::model::runtime_probe::onnx_runtime_experiment'
CONFIGS = [(3, 1, 1), (1, 1, 1), (1, 2, 1), (1, 3, 1), (1, 6, 1),
           (4, 1, 1), (6, 1, 1), (3, 2, 1), (3, 1, 2), (3, 1, 4),
           (3, 1, 8), (1, 3, 4)]


def write(path, data):
    path.write_text(json.dumps(data, indent=2) + '\n')


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def compare(path, reference):
    data = path.read_bytes()
    assert len(data) == len(reference) and len(data) % (384 * 4) == 0
    a, b = array.array('f'), array.array('f')
    a.frombytes(data)
    b.frombytes(reference)
    assert all(math.isfinite(x) for x in a)
    cosine = []
    for start in range(0, len(a), 384):
        x, y = a[start:start+384], b[start:start+384]
        cosine.append(sum(i*j for i, j in zip(x, y)) / math.sqrt(sum(i*i for i in x)*sum(j*j for j in y)))
    return {'max_component_difference': max(abs(i-j) for i, j in zip(a, b)),
            'minimum_cosine': min(cosine),
            'exact_vectors': sum(data[i:i+1536] == reference[i:i+1536] for i in range(0, len(data), 1536)),
            'vectors_sha256': hashlib.sha256(data).hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--projects', type=Path, required=True)
    parser.add_argument('--per-corpus', type=int, default=128)
    parser.add_argument('--repeats', type=int, default=3)
    args = parser.parse_args()
    root = args.root.resolve()
    root.mkdir(parents=True, exist_ok=False)
    binary = root / 'runtime-probe'
    shutil.copy2(args.binary, binary)
    report = {'binary_sha256': sha(binary), 'host': platform.platform(),
              'cpu': subprocess.check_output(['sysctl', '-n', 'machdep.cpu.brand_string'], text=True).strip(),
              'logical_cpus': os.cpu_count(), 'per_corpus': args.per_corpus,
              'repeats': args.repeats, 'runs': []}

    def invoke(label, config, timeout=90):
        config = {'root': str(root), **config}
        path = root / f'{label}-config.json'
        write(path, config)
        env = {**os.environ, 'MIMIRS_RUNTIME_PROBE_CONFIG': str(path), 'TOKENIZERS_PARALLELISM': 'false', 'NO_COLOR': '1'}
        command = ['/usr/bin/time', '-l', '-o', str(root / f'{label}.time'), str(binary), TEST, '--exact', '--ignored', '--nocapture']
        start = time.perf_counter()
        with (root / f'{label}.stdout').open('w') as stdout, (root / f'{label}.stderr').open('w') as stderr:
            process = subprocess.Popen(command, env=env, stdout=stdout, stderr=stderr, start_new_session=True)
            try:
                returncode = process.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                # Stop the exact process group created for this trial, including
                # the probe under /usr/bin/time, before starting another trial.
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
                return {'status': 'timeout', 'timeout_seconds': timeout}
        if returncode:
            raise RuntimeError((root / f'{label}.stderr').read_text() + (root / f'{label}.stdout').read_text())
        output = (root / f'{label}.stdout').read_text()
        rows = [line.split('RUNTIME_REPORT=', 1)[1] for line in output.splitlines() if 'RUNTIME_REPORT=' in line]
        assert len(rows) == 1, output
        row = json.loads(rows[0])
        raw = (root / f'{label}.time').read_text()
        cpu = re.search(r'([\d.]+) real\s+([\d.]+) user\s+([\d.]+) sys', raw)
        rss = re.search(r'(\d+)\s+maximum resident set size', raw)
        row.update({'status': 'complete', 'process_seconds': time.perf_counter()-start,
                    'process_user_seconds': float(cpu[2]) if cpu else None,
                    'process_system_seconds': float(cpu[3]) if cpu else None,
                    'process_peak_rss_bytes': int(rss[1]) if rss else None})
        return row

    print('CAPTURE real windows and production reference', flush=True)
    capture = invoke('capture', {'action': 'capture', 'projects': str(args.projects.resolve()), 'per_corpus': args.per_corpus}, timeout=240)
    assert capture['status'] == 'complete'
    assert [c['population'] for c in capture['corpora']] == [1572, 13388, 36967]
    report['capture'] = capture
    report['inputs_sha256'] = sha(root / 'inputs.json')
    report['model_sha256'] = sha(Path(capture['model_path']))
    report['tokenizer_sha256'] = sha(Path(capture['tokenizer_path']))
    assert report['model_sha256'] == 'afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1'
    assert report['tokenizer_sha256'] == 'da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0'
    reference = (root / 'reference.bin').read_bytes()
    report['reference_sha256'] = hashlib.sha256(reference).hexdigest()
    write(root / 'report.json', report)
    for trial in range(args.repeats):
        order = CONFIGS if trial % 3 == 0 else list(reversed(CONFIGS)) if trial % 3 == 1 else CONFIGS[6:]+CONFIGS[:6]
        for sessions, threads, batch in order:
            label = f's{sessions}-t{threads}-b{batch}-r{trial}'
            print('RUN', label, flush=True)
            row = invoke(label, {'action': 'replay', 'sessions': sessions, 'threads': threads, 'batch': batch, 'label': label})
            row.update({'label': label, 'trial': trial, 'sessions': sessions, 'intra_threads': threads, 'batch': batch})
            if row['status'] == 'complete':
                row.update(compare(root / f'{label}.bin', reference))
                print('DONE', label, round(row['replay_wall_seconds'], 3), 's', 'max error', row['max_component_difference'], flush=True)
            report['runs'].append(row)
            write(root / 'report.json', report)
    print('PROFILE representative singleton calls separately', flush=True)
    profile = invoke('operators', {'action': 'replay', 'sessions': 1, 'threads': 1, 'batch': 1, 'label': 'operators', 'profile': True, 'limit': 48})
    report['profile'] = profile
    n = capture['windows']
    subset = b''.join(reference[((2*i+1)*n//96)*1536:((2*i+1)*n//96+1)*1536] for i in range(48))
    profile.update(compare(root / 'operators.bin', subset))
    operators = {}
    for trace in profile['traces']:
        for event in json.loads(Path(trace).read_text()):
            if event.get('cat') != 'Node' or not event.get('name', '').endswith('_kernel_time'):
                continue
            key = event.get('args', {}).get('op_name', 'unknown')
            value = operators.setdefault(key, {'events': 0, 'microseconds': 0, 'providers': []})
            value['events'] += 1
            value['microseconds'] += event.get('dur', 0)
            provider = event.get('args', {}).get('provider')
            if provider and provider not in value['providers']:
                value['providers'].append(provider)
    report['operators'] = dict(sorted(operators.items(), key=lambda item: -item[1]['microseconds']))
    assert operators
    report['summary'] = []
    for sessions, threads, batch in CONFIGS:
        rows = [r for r in report['runs'] if (r['sessions'], r['intra_threads'], r['batch']) == (sessions, threads, batch) and r['status'] == 'complete']
        if not rows:
            continue
        times = [r['replay_wall_seconds'] for r in rows]
        report['summary'].append({'sessions': sessions, 'intra_threads': threads, 'batch': batch,
                                  'completed_trials': len(rows), 'median_seconds': statistics.median(times),
                                  'min_seconds': min(times), 'max_seconds': max(times),
                                  'median_windows_per_second': statistics.median(r['windows_per_second'] for r in rows),
                                  'max_component_difference': max(r['max_component_difference'] for r in rows),
                                  'min_exact_vectors': min(r['exact_vectors'] for r in rows),
                                  'min_cosine': min(r['minimum_cosine'] for r in rows),
                                  'median_peak_rss_bytes': statistics.median(r['process_peak_rss_bytes'] for r in rows)})
    write(root / 'report.json', report)
    print(json.dumps(report['summary'], indent=2), flush=True)


if __name__ == '__main__':
    main()
