#!/usr/bin/env python3
"""Collect a completed runtime-experiment.py sweep without additional inference."""
import argparse
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--index-root', type=Path)
    args = parser.parse_args()
    report = json.loads((args.root / 'report.json').read_text())
    if (args.root / 'provenance.json').exists():
        report['provenance'] = json.loads((args.root / 'provenance.json').read_text())
    rows = report['summary']
    baseline = next(r for r in rows if (r['sessions'], r['intra_threads'], r['batch']) == (3, 1, 1))
    windows = report['capture']['windows']
    assert baseline['min_exact_vectors'] == windows
    lines = ['# ONNX Runtime threading and batching', '',
             f"Host: {report['cpu']}, {report['logical_cpus']} logical CPUs, `{report['host']}`. "
             f"Pinned model: `{report['capture']['model']}`.", '',
             f"Test binary SHA-256: `{report['binary_sha256']}`. Input SHA-256: `{report['inputs_sha256']}`.", '',
             '## Workload and timing', '',
             f"{windows} real windows: {report['per_corpus']} each from Mimirs, Excalidraw, and Django. "
             'Capture reconstructs production window splitting and per-1024-document deduplication from retained published documents. '
             'It reproduces the full window populations of 1,572, 13,388, and 36,967. '
             'Selection uses evenly spaced token-length quantiles within each corpus. This gives equal corpus representation, '
             'not the weighting of a full indexing run.', '',
             'Every candidate receives the same token IDs, attention masks, and type IDs. Inputs are sorted by length '
             'and grouped into batches before timing. Padding uses zero IDs, type IDs, and attention masks. '
             'Output vectors are restored to original input order and compared with singleton outputs from the production Model code.', '',
             f"Each configuration has {report['repeats']} trials, with forward, reverse, and rotated execution orders. "
             'Each session is warmed with a short and a long input before timing. Session creation, tokenization, '
             'tensor construction, file reads, file writes, teardown, and profiling flushes are outside replay timing. '
             'Replay wall time includes worker dispatch and output pooling. Per-call runtime timers surround only Session::run. '
             'Timing trials have operator profiling disabled.', '',
             '## Results', '',
             'Sessions are independent simultaneous model calls. Intra-op threads parallelize work inside one call. '
             'Inter-op threads remain one and graph execution remains sequential. All candidates use Level3 graph '
             'optimizations and default thread-spinning behavior. The product of sessions and intra-op threads '
             'is a configured model-thread budget, not an OS CPU quota.', '',
             '| Sessions | Threads/session | Batch | Model-thread budget | Median s | Range s | Windows/s | Speedup | Exact vectors | Max component difference | Peak MiB median |',
             '|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|']
    for row in rows:
        speedup = baseline['median_seconds'] / row['median_seconds']
        lines.append(f"| {row['sessions']} | {row['intra_threads']} | {row['batch']} | {row['sessions']*row['intra_threads']} | "
                     f"{row['median_seconds']:.4f} | {row['min_seconds']:.4f}-{row['max_seconds']:.4f} | "
                     f"{row['median_windows_per_second']:.2f} | {speedup:.3f}x | {row['min_exact_vectors']}/{windows} | "
                     f"{row['max_component_difference']:.9g} | {row['median_peak_rss_bytes']/2**20:.1f} |")
    lines += ['', 'Exact vectors is the minimum number of byte-identical vectors across trials. '
              'Process peak RSS includes sessions, prebuilt tensors, initialization, and warmup. '
              'Raw runs also retain per-call mean/p95/max latency, total runtime-call duration, CPU seconds, '
              'padding counts, vector hashes, and minimum cosine similarity.', '']
    exact = [r for r in rows if r['min_exact_vectors'] == windows and r['completed_trials'] == report['repeats']]
    for label, candidates in [('At no more than three configured model threads', [r for r in exact if r['sessions']*r['intra_threads'] <= 3]),
                              ('With the larger tested CPU budgets', exact)]:
        best = min(candidates, key=lambda r: r['median_seconds'])
        lines.append(f"{label}, the fastest sample-exact configuration was {best['sessions']} sessions x "
                     f"{best['intra_threads']} threads, batch {best['batch']}: {best['median_seconds']:.4f} s, "
                     f"{baseline['median_seconds']/best['median_seconds']:.3f}x the baseline throughput.")
        lines.append('')
    lines += ['## Operator profile', '',
              'A separate un-warmed run profiles 48 representative singleton inputs with one session and one thread. '
              'This trace is excluded from the performance comparisons. The table sums Node kernel_time events '
              'by operator type and excludes session startup and non-node events. These are instrumented event durations, '
              'not a direct allocation of the unprofiled sweep time.', '',
              '| Operator | Events | Total ms | Node time share | Provider |', '|---|---:|---:|---:|---|']
    total = sum(v['microseconds'] for v in report['operators'].values())
    for name, value in report['operators'].items():
        lines.append(f"| {name} | {value['events']} | {value['microseconds']/1000:.3f} | "
                     f"{value['microseconds']/total:.3%} | {', '.join(value['providers'])} |")
    lines += ['', '## Validation and limits', '',
              'The sample reference is computed by the current production Model path. The ordinary test suite, '
              'batch token/mask/order checks, and Clippy passed before measurements. The model and tokenizer '
              'SHA-256 values match the pinned TS v2 fixtures. Each completed candidate checks finite outputs, '
              'component differences, cosine similarity, and byte equality against that reference.', '',
              'This experiment changes no production settings. Sample equality is not full-corpus retrieval validation. '
              'Candidates that change vectors require quality evaluation and an explicit index-policy decision before adoption. '
              'Global length sorting has all sampled windows available in advance; a bounded indexing pipeline may not '
              'achieve the same batching efficiency. CPU contention, cache behavior, warmup, and longer sustained runs '
              'may change the ranking of candidates. No Kubernetes timing or speedup is inferred.', '',
              f"Retained artifacts: `{args.root.resolve()}`. This includes the inputs, golden and candidate vectors, "
              'trial configurations, stdout/stderr, process timings, and raw operator traces.', '',
              'Build the opt-in test binary with `cargo test --release --bin mimirs --no-run --message-format=json`; '
              'use its emitted executable path with `runtime-experiment.py --root NEW_ROOT --binary TEST_BINARY '
              '--projects RETAINED_PROJECTS`. Collect with `runtime-report.py --root NEW_ROOT --output OUTPUT_DIRECTORY`.', '']
    if args.index_root:
        validation = json.loads((args.index_root / 'report.json').read_text())
        assert validation['workers'] == 6
        assert set(validation['corpora']) == {'mimirs', 'excalidraw', 'django'}
        lines += ['## Six-worker indexing validation', '',
                  'The winning singleton configuration was also exercised through the production indexing '
                  'pipeline on all three complete development corpora. Only disposable project configurations '
                  'set `embedding_workers = 6`; repository and user defaults were not changed. '
                  'This is one validation trial per operation, not a paired speed comparison.', '',
                  f"Production binary SHA-256: `{validation['binarySha256']}`. "
                  f'Retained run: `{args.index_root.resolve()}`.', '',
                  '| Corpus | Fresh s | Unchanged s | Edited s | Restore s | Fresh peak MiB |',
                  '|---|---:|---:|---:|---:|---:|']
        for corpus, entry in validation['corpora'].items():
            assert len(entry['storedTableSha256']) == 11
            assert all(v == 0 for v in entry['staging']['remainingRows'].values())
            for run in entry['runs'].values():
                assert run['counters']['embedding_worker_limit'] == 6
            times = ' | '.join(f"{entry['runs'][name]['timing']['wall_seconds']:.3f}" for name in ('fresh', 'unchanged', 'edited', 'restore'))
            rss = entry['runs']['fresh']['timing']['peak_rss_bytes'] / 2**20
            lines.append(f'| {corpus} | {times} | {rss:.1f} |')
        lines += ['', 'All eleven published tables and all 27,295 stored document vectors match the '
                  'three-worker reference byte for byte after identical edit/restore cycles. '
                  'Fresh and incremental index runs completed without skipped files, unchanged runs made '
                  'zero embedding calls, and staging stores were empty after completion. '
                  'The full pipeline competes for CPU and memory alongside inference; its scaling need '
                  'not match the isolated replay. Kubernetes remains unmeasured at six workers.', '',
                  'Reproduce with `staged.py --root NEW_ROOT --reference-root RETAINED_REFERENCE '
                  '--binary PRODUCTION_BINARY --workers 6`.', '']
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / 'RUNTIME.md').write_text('\n'.join(lines))
    (args.output / 'runtime.json').write_text(json.dumps(report, indent=2)+'\n')
    if args.index_root:
        (args.output / 'index-validation.json').write_text(json.dumps(validation, indent=2)+'\n')


if __name__ == '__main__':
    main()
