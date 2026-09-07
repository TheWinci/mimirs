#!/usr/bin/env python3
"""Alternate unprofiled fresh trials across baseline, scheduling and persistence.

Default to the small pinned corpus to quantify noise without repeating the
larger diagnostic runs. No performance claim about a larger corpus follows
from these small-corpus trials. Timed commands must run without competing work.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import statistics

from pipeline import logical_hashes, module
from run import config, measure, write


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--reference-root', type=Path, required=True)
    for label in ('baseline', 'scheduling', 'persisted'):
        parser.add_argument(f'--{label}', type=Path, required=True)
    parser.add_argument('--corpora', nargs='+', choices=('mimirs', 'excalidraw', 'django'), default=['mimirs'])
    args = parser.parse_args()
    root = args.root.resolve()
    root.mkdir(parents=True, exist_ok=False)
    (root / 'corpora').symlink_to(args.reference_root.resolve() / 'corpora')
    (root / 'engines').mkdir()
    binaries = {}
    for label in ('baseline', 'scheduling', 'persisted'):
        binary = root / 'engines' / label
        shutil.copy2(getattr(args, label), binary)
        binaries[label] = binary
    report = {'binarySha256': {label: hashlib.sha256(binary.read_bytes()).hexdigest() for label, binary in binaries.items()},
              'workers': 3, 'profiled': False, 'repeats': 3,
              'scope': 'Cached assets, separate fresh indexes, rotating candidate order. Timed commands run sequentially without competing tests or audits. These trials apply only to the listed corpora.', 'corpora': {}}
    baseline = module('port-baseline')
    for corpus in args.corpora:
        manifest = baseline.verify_manifest(root, corpus)
        entry = report['corpora'][corpus] = {'manifestSha256': manifest['manifest_sha256'], 'querySha256': manifest['query_sha256'], 'trials': []}
        expected = None
        labels = list(binaries)
        for trial in range(3):
            for label in labels[trial:] + labels[:trial]:
                project = root / 'projects' / f'{corpus}-{label}-{trial}'
                shutil.copytree(root / 'corpora' / corpus, project)
                config(project, 'rust')
                prefix = root / 'results' / corpus / label / str(trial) / 'fresh'
                print('INDEX', corpus, label, trial, flush=True)
                timing = measure([str(binaries[label]), 'index'], project, prefix)
                baseline.verify_project(project, manifest)
                actual = logical_hashes(project / '.mimirs/index.db')
                if expected is None:
                    expected = actual
                assert actual == expected, 'published output changed'
                entry['trials'].append({'label': label, 'trial': trial, **timing})
                print('DONE', corpus, label, trial, round(timing['wall_seconds'], 3), flush=True)
                if trial:
                    shutil.rmtree(project)
                write(root / 'report.json', report)
        entry['publishedTableSha256'] = expected
        entry['freshMedianSeconds'] = {label: statistics.median(row['wall_seconds'] for row in entry['trials'] if row['label'] == label) for label in labels}
        write(root / 'report.json', report)


if __name__ == '__main__':
    main()
