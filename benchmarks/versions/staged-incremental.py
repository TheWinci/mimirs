#!/usr/bin/env python3
"""Compare incremental indexing on copies of a retained Kubernetes checkpoint.

No fresh index is built. Each candidate starts with the same complete snapshot,
uses the fixed two-file edit, then restores source. Run timed commands sequentially.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil

from pipeline import logical_hashes, module
from run import edit_files, measure, write

HERE = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--reference-root', type=Path, required=True)
    for label in ('baseline', 'before', 'after'):
        parser.add_argument(f'--{label}', type=Path, required=True)
    args = parser.parse_args()
    root, reference = args.root.resolve(), args.reference_root.resolve()
    root.mkdir(parents=True, exist_ok=False)
    (root / 'engines').mkdir()
    binaries = {}
    for label in ('baseline', 'before', 'after'):
        binaries[label] = root / 'engines' / label
        shutil.copy2(getattr(args, label), binaries[label])
    manifest = module('port-baseline').verify_manifest(reference, 'kubernetes')
    queries = json.loads((HERE / 'queries/kubernetes.json').read_text())
    edits = edit_files(manifest, queries)
    report = {'binarySha256': {label: hashlib.sha256(binary.read_bytes()).hexdigest() for label, binary in binaries.items()},
              'repeats': 2, 'workers': 3, 'profiled': False,
              'manifestSha256': manifest['manifest_sha256'], 'querySha256': manifest['query_sha256'],
              'editPaths': [edit['path'] for edit in edits], 'trials': []}
    expected = None
    for trial in range(2):
        labels = ('baseline', 'before', 'after') if trial == 0 else ('after', 'before', 'baseline')
        for label in labels:
            project = root / 'projects' / f'{label}-{trial}'
            shutil.copytree(reference / 'projects/kubernetes-rust-0', project)
            row = {'label': label, 'trial': trial, 'runs': {}}
            for stage in ('edited', 'restore'):
                for entry in edits:
                    original = (reference / 'corpora/kubernetes' / entry['path']).read_bytes()
                    (project / entry['path']).write_bytes(original + (b'\n// mimirs benchmark incremental edit\n' if stage == 'edited' else b''))
                prefix = root / 'results' / label / str(trial) / stage
                print('INDEX', label, trial, stage, flush=True)
                timing = measure([str(binaries[label]), 'index'], project, prefix)
                text = prefix.with_suffix('.stdout').read_text()
                assert 'indexed: 2 files\n' in text and 'unchanged: 8788 files\n' in text
                row['runs'][stage] = timing
                print('DONE', label, trial, stage, round(timing['wall_seconds'], 3), flush=True)
            actual = logical_hashes(project / '.mimirs/index.db')
            if expected is None:
                expected = actual
            assert actual == expected, 'published tables or vectors changed'
            report['publishedTableSha256'] = expected
            report['trials'].append(row)
            write(root / 'report.json', report)
            if trial:
                shutil.rmtree(project)


if __name__ == '__main__':
    main()
