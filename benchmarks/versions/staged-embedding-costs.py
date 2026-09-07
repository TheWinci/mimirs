#!/usr/bin/env python3
"""Collect per-call embedding costs from staged.py reports; no inference runs."""
import argparse
import json
from pathlib import Path

from run import write

COSTS = {
    'embedding_tokenization': 'Tokenization',
    'embedding_inputs': 'Input arrays and tensors',
    'embedding_runtime': 'ONNX Runtime call',
    'embedding_pooling': 'Output extraction, pooling, normalization',
    'embedding_cleanup': 'Temporary buffer cleanup',
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    report = json.loads((args.root / 'report.json').read_text())
    provenance = args.root / 'provenance.json'
    if provenance.exists():
        report['provenance'] = json.loads(provenance.read_text())
    lines = [
        '# Embedding call costs', '',
        'One diagnostic run per pinned development corpus, with three single-threaded inference '
        'sessions, singleton model inputs, cached assets, and the existing quantized MiniLM model. '
        'No worker, batch, model, token-window, or inference optimization was applied.', '',
        f"Binary SHA-256: `{report['binarySha256']}`.", '',
        f'Raw profiles: `{args.root.resolve()}/results/<corpus>/<operation>-profile.json`.', '',
        '## Timer boundaries', '',
        '- Tokenization covers encoding each submitted text, padding, and truncation.',
        '- Input preparation covers validating padded lengths, building integer arrays, copying the attention mask, and constructing ONNX tensors.',
        '- Runtime covers the synchronous `Session::run` call, including Rust/C binding overhead and internal runtime work. It does not isolate individual operators or pure matrix computation.',
        '- Pooling covers output extraction, shape validation, masked mean pooling, and normalization with the existing float64/float32 rules.',
        '- Cleanup releases output tensors, the retained mask, and token encodings after success. Input values consumed by `Session::run` are released within its runtime boundary.',
        '- Other is outer inference-worker active time minus the five measured components. It includes validation, call transitions, and instrumentation overhead.', '',
        'All values below are summed worker wall durations. The three workers overlap, so these '
        'values can exceed elapsed indexing time. Percentages use outer inference-worker active '
        'time as the denominator. Per-call averages use the measured singleton call count. '
        'Pre-submission window planning is reported separately and is not included in these percentages.', '',
    ]
    totals = dict.fromkeys(COSTS, 0.0)
    total_active = total_calls = 0
    for corpus, entry in report['corpora'].items():
        for operation, run in entry['runs'].items():
            calls = run['counters'].get('embedding_profiled_calls', 0)
            assert calls == run['counters'].get('embedding_calls', 0)
            assert calls == run['stages'].get('inference', {}).get('items', 0)
            if operation == 'unchanged':
                assert calls == 0
                assert not any(run['phases'].get(key, 0) for key in COSTS)
            else:
                assert calls > 0
                assert all(run['phases'][key] > 0 for key in COSTS)
                assert sum(run['phases'][key] for key in COSTS) <= run['stages']['inference']['active_seconds']
        run = entry['runs']['fresh']
        calls = run['counters']['embedding_profiled_calls']
        active = run['stages']['inference']['active_seconds']
        other = active - sum(run['phases'][key] for key in COSTS)
        total_active += active
        total_calls += calls
        lines += [f'## {corpus}', '',
                  f"Fresh process elapsed time: {run['timing']['wall_seconds']:.3f} s. "
                  f"Profile interval: {run['profileWallSeconds']:.3f} s. "
                  f'{calls:,} singleton calls; {active:.3f} s summed outer worker active time.', '',
                  '| Component | Worker seconds | Share | Mean ms per call |',
                  '|---|---:|---:|---:|']
        for key, label in COSTS.items():
            seconds = run['phases'][key]
            totals[key] += seconds
            lines.append(f'| {label} | {seconds:.6f} | {seconds / active:.3%} | {1000 * seconds / calls:.6f} |')
        lines += [f'| Other and measurement overhead | {other:.6f} | {other / active:.3%} | {1000 * other / calls:.6f} |', '',
                  f"Pre-submission window planning (`embedding_prepare`): {run['phases']['embedding_prepare']:.3f} s. "
                  f"Inter-window vector merging (`vector_merge`): {run['phases']['vector_merge']:.6f} s. "
                  'These run outside the measured worker call and may overlap it.', '']
    lines += ['## Combined fresh-call breakdown', '',
              f'{total_calls:,} calls, weighted by their measured worker time.', '',
              '| Component | Worker seconds | Share |', '|---|---:|---:|']
    for key, label in COSTS.items():
        lines.append(f'| {label} | {totals[key]:.6f} | {totals[key] / total_active:.3%} |')
    other = total_active - sum(totals.values())
    lines += [f'| Other and measurement overhead | {other:.6f} | {other / total_active:.3%} |', '',
              '## Validation and limits', '',
              'Measured call counts equal the existing embedding-call and worker-item counts for all twelve '
              'fresh, unchanged, edit, and restore runs. Unchanged runs have no model calls or component costs. '
              'All eleven published tables, including vector bytes, match the retained reference after the '
              'same edit/restore cycle. Staging stores are empty after completion.', '',
              'The standard tests, a focused real-model comparison of instrumented parallel calls against '
              'unprofiled singleton calls, formatting, and Clippy passed before measurements. '
              'No builds, tests, or other inference benchmarks overlapped the timed commands.', '',
              'This is a cost breakdown, not an optimization trial or a paired measurement of profiling overhead. '
              'Timers measure wall duration inside each worker, including descheduling and any runtime waits. '
              'The runtime bucket does not prove that every measured second is arithmetic. '
              'Kubernetes was not rerun; these numbers do not directly measure its cost distribution.', '',
              'Reproduce with `staged.py --root NEW_ROOT --reference-root RETAINED_REFERENCE --binary CANDIDATE`, '
              'then `staged-embedding-costs.py --root NEW_ROOT --output OUTPUT_DIRECTORY`. '
              'The collector performs no inference.', '']
    args.output.mkdir(parents=True, exist_ok=True)
    write(args.output / 'embedding-costs.json', report)
    (args.output / 'EMBEDDING-COSTS.md').write_text('\n'.join(lines))


if __name__ == '__main__':
    main()
