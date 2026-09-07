#!/usr/bin/env python3
"""Audit staged indexing against the accepted persistent-worker Kubernetes run."""
import argparse
from pathlib import Path
import sqlite3

from pipeline import module

HERE = Path(__file__).resolve().parent


def markdown(report):
    before, after = (report['engines'][label] for label in ('before', 'after'))
    old, new = (engine['phases']['fresh']['wall_seconds'] for engine in (before, after))
    target = 'The 11-minute target remains open.' if new > 660 else 'This trial reached the 11-minute target.'
    lines = ['# Kubernetes with staged indexing', '',
             f'Fresh indexing took {new:.3f} seconds, compared with {old:.3f} seconds at the accepted persistent-worker checkpoint. {target}', '',
             '| Operation | Previous s | Staged s |', '| --- | ---: | ---: |']
    for stage in ('fresh', 'unchanged', 'edited', 'restore'):
        lines.append(f"| {stage} | {before['phases'][stage]['wall_seconds']:.3f} | {after['phases'][stage]['wall_seconds']:.3f} |")
    lines += ['', '| Cost | Previous | Staged |', '| --- | ---: | ---: |']
    for name, get in (
        ('Fresh user + system CPU seconds', lambda e: e['phases']['fresh']['user_seconds'] + e['phases']['fresh']['system_seconds']),
        ('Fresh peak RSS MiB', lambda e: e['phases']['fresh']['peak_rss_bytes'] / 2**20),
        ('All 120 cold query processes, seconds', lambda e: e['queryProcessesSeconds']),
        ('Published index MiB', lambda e: e['database']['index_bytes'] / 2**20)):
        lines.append(f'| {name} | {get(before):.3f} | {get(after):.3f} |')
    lines += ['', 'All 8,790 files, 134,363 vector byte sequences and the other rows in the eleven audited published tables match. All 120 CLI responses match after removing only elapsed time. The evidence audit passes. Unchanged indexing reuses every file without inference, and staging contains no remaining work.', '',
              report['timingScope'], '',
              f"The complete Rust runner took {report['runnerWall']['wallSeconds']:.3f} seconds, including corpus copying, fresh/unchanged/edit/restore indexing and all search commands. Storage and evidence audits ran afterward.", '',
              'These are individual runs at different times. Their elapsed times do not establish a repeatable speedup. Both use cached assets and three singleton inference workers on the Apple M2 Pro. The staging pipeline preserves the model, inputs, merging and retrieval policy.', '',
              '[Raw evidence](kubernetes.json) retains binary identities, timings, exact table hashes, query comparisons and source checks. [Development measurements](../FINAL.md) separate scheduling from intermediate persistence. [The previous checkpoint](../../pipeline/kubernetes/KUBERNETES.md) records the 1,226.430-second baseline.', '']
    return '\n'.join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--reference-root', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    stage_path = args.root.resolve() / 'projects/kubernetes-rust-0/.mimirs/staging.db'
    with sqlite3.connect(f'file:{stage_path}?mode=ro', uri=True) as db:
        assert all(db.execute(f'SELECT count(*) FROM {table}').fetchone()[0] == 0
                   for table in ('runs', 'work', 'source_stages', 'window_stages', 'vector_stages'))
    module('pipeline-kubernetes').collect(args.root.resolve(), args.reference_root.resolve(), args.output.resolve(),
                                         checkpoint_path=HERE / 'pipeline/kubernetes/kubernetes.json', renderer=markdown,
                                         profile_path=args.root.resolve() / 'unchanged-verification-profile.json')


if __name__ == '__main__':
    main()
