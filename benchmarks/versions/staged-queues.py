#!/usr/bin/env python3
"""Collect item queue residence from staged.py reports without running inference."""
import argparse
import json
from pathlib import Path

from run import write

HERE = Path(__file__).resolve().parent
NAMES = {
    'paths': 'Discovered paths',
    'admission': 'File admission gate',
    'parsed': 'Parsed files awaiting window planning',
    'prepared': 'Submitted jobs awaiting the merger',
    'inference': 'Windows awaiting an inference worker',
    'writer': 'Messages awaiting the database writer',
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
    baseline = json.loads((HERE / 'staged/baseline-stages.json').read_text())
    lines = [
        '# Item queue residence', '',
        'One diagnostic run per development corpus, with three inference workers and cached model assets. '
        'Fresh, unchanged, two-file edit, and restore runs are retained in `queue-residence.json`. '
        'All published tables and vector bytes match the retained reference after the same edit/restore cycle. '
        'These are measurements of the staged implementation with added instrumentation, not repeated speed comparisons.', '',
        f"Binary SHA-256: `{report['binarySha256']}`.", '',
        f'Raw profiles: `{args.root.resolve()}/results/<corpus>/<operation>-profile.json`.', '',
        '## What the clocks measure', '',
        'Channel clocks start only after a send is accepted and stop when the consumer dequeues the item. '
        'Producer blocking before acceptance and processing after dequeue are excluded. '
        'The admission gate records request-to-grant delay. Inference records each window separately '
        'from its file job submission until a worker dispatches it. Percentiles use nearest rank. '
        'Cancelled items that never dequeue are excluded.', '',
        'Channel counts include the end marker. Writer messages include discovered/source/window/vector stages '
        'and file completion. The shutdown channel carries no items; its close wait is lifecycle coordination.', '',
        'Prepared messages hold already-submitted jobs, so their queue time overlaps inference queue time and model work. '
        'Queue totals overlap across items and stages. They must not be added to wall time. '
        'Mean queued items is total item residence divided by profile wall time for these completed runs.', '',
    ]
    for corpus, entry in report['corpora'].items():
        run = entry['runs']['fresh']
        assert run['profileVersion'] == 3
        queues, stages = run['queues'], run['stages']
        inference = stages['inference']
        old = baseline['corpora'][corpus]['stages']['inference']
        busy = inference['active_seconds'] / (inference['active_seconds'] + inference['input_wait_seconds'])
        old_busy = old['active_seconds'] / (old['active_seconds'] + old['input_wait_seconds'])
        floor = inference['active_seconds'] / report['workers']
        assert queues['inference']['items'] == inference['items'] == run['counters']['embedding_calls']
        lines += [
            f'## {corpus}', '',
            f"Fresh process wall time {run['timing']['wall_seconds']:.3f} s; profile interval {run['profileWallSeconds']:.3f} s. "
            f'Inference workers spend {busy:.2%} of their recorded active-plus-idle time inside model calls. '
            f'The pre-staging profile was already {old_busy:.2%}. '
            f"Summed inference call time is {inference['active_seconds']:.3f} s, or {floor:.3f} s divided among three workers. "
            f"Mean model-call duration is {1000 * inference['active_seconds'] / inference['items']:.3f} ms. "
            'This is a lower bound for the measured call costs at this worker count, not a prediction for faster kernels or additional workers.', '',
            '| Queue or gate | Items | Mean ms | Median ms | p95 ms | Max ms | Mean queued items |',
            '|---|---:|---:|---:|---:|---:|---:|',
        ]
        for key, name in NAMES.items():
            queue = queues[key]
            occupancy = 'n/a' if key == 'admission' else f"{queue['total_seconds'] / run['profileWallSeconds']:.2f}"
            values = ' | '.join(f"{queue[field] * 1000:.3f}" for field in ('mean_seconds', 'p50_seconds', 'p95_seconds', 'max_seconds'))
            lines.append(f"| {name} | {queue['items']} | {values} | {occupancy} |")
        lines += ['',
            f"The parser spends {stages['source']['output_wait_seconds']:.3f} s blocked on file admission. "
            f"The window planner waits {stages['parsed']['input_wait_seconds']:.3f} s for input. "
            f"The merger waits {stages['inference_completion']['input_wait_seconds']:.3f} s for inference completion. "
            f"The database writer waits {stages['writer']['input_wait_seconds']:.3f} s for messages, "
            f"and its database work totals {stages['database']['active_seconds']:.3f} s. "
            f"Producers spend {stages['writer']['output_wait_seconds']:.3f} s blocked by a full writer channel. "
            'These concurrent worker durations also overlap.', '',
        ]
        profile = json.loads((args.root / 'results' / corpus / 'fresh-profile.json').read_text())
        oversized = []
        for file in profile['files']:
            size = (args.root / 'projects' / corpus / file['path']).stat().st_size
            reservation = 64 * size + 64 * len(file['path'].encode()) + 65536
            if reservation > 32 * 2**20:
                oversized.append((file, size, reservation))
        if oversized:
            lines += ['The conservative admission estimate also introduces isolated large-file work. '
                      'Files whose reservation exceeds 32 MiB run alone. Their entire window plan is built '
                      'before submission, leaving inference idle during that preparation.', '',
                      '| Isolated file | Source bytes | Reserved MiB | Window planning seconds |',
                      '|---|---:|---:|---:|']
            for file, size, reservation in oversized:
                planning = file['phases_seconds'].get('embedding_prepare', 0)
                lines.append(f"| `{file['path']}` | {size} | {reservation / 2**20:.2f} | {planning:.3f} |")
            lines += ['', 'This supports a smaller scheduling opportunity: allow window production to feed '
                      'inference incrementally within one oversized file, with bounded memory and unchanged '
                      'deduplication and output vectors. It does not explain a multi-minute gap by itself.', '']
    lines += [
        '## Interpretation and limits', '',
        'The long path and admission waits are backpressure from the bounded number of files in flight. '
        'The inference queue remains supplied while the model workers are busy. '
        'Moving waiting work farther downstream, or increasing queue capacity, does not itself increase model throughput. '
        'The baseline already overlapped preparation with persistent inference workers; additional stage separation '
        'therefore has little idle inference time to recover. The next throughput experiments should measure '
        'inference worker scaling and model-call cost while keeping retrieval parity explicit.', '',
        'The completed fresh Kubernetes run had no profile. Its 1,219.085 s versus the previous 1,226.430 s '
        'is a 0.60% single-trial difference, not convincing evidence of a speedup. '
        'No per-item Kubernetes queue times can be reconstructed from those logs. '
        'The development profiles support an inference-throughput explanation, but do not directly measure fresh Kubernetes queues.', '',
        'Profiling adds clock reads, reporting-lock acquisitions, and one f64 sample per dequeued item. '
        'Normal indexing does not read these clocks or retain samples. '
        'The diagnostic run does not isolate instrumentation overhead, and the historical profiles are not paired trials.', '',
        'Reproduce with `staged.py --root NEW_ROOT --reference-root RETAINED_REFERENCE --binary CANDIDATE`, '
        'then `staged-queues.py --root NEW_ROOT --output OUTPUT_DIRECTORY`. '
        'The collector performs no inference.', '',
    ]
    args.output.mkdir(parents=True, exist_ok=True)
    write(args.output / 'queue-residence.json', report)
    (args.output / 'QUEUES.md').write_text('\n'.join(lines))


if __name__ == '__main__':
    main()
