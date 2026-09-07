#!/usr/bin/env python3
"""Measure one staged candidate and compare published bytes to a retained run.

Uses only the pinned Mimirs, Excalidraw and Django development corpora. Run
sequentially without competing builds, tests or audits. This is a diagnostic
single trial; use pipeline.py for alternating repeated comparisons.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil

from pipeline import logical_hashes, module
from run import config, edit_files, measure, write

HERE = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--reference-root', type=Path, required=True)
    parser.add_argument('--binary', type=Path, required=True)
    args = parser.parse_args()
    root, reference = args.root.resolve(), args.reference_root.resolve()
    root.mkdir(parents=True, exist_ok=False)
    (root / 'corpora').symlink_to(reference / 'corpora')
    (root / 'engines').mkdir()
    binary = root / 'engines/mimirs'
    shutil.copy2(args.binary, binary)
    baseline = module('port-baseline')
    report = {'binarySha256': hashlib.sha256(binary.read_bytes()).hexdigest(),
              'workers': 3, 'corpora': {}}
    for corpus in ('mimirs', 'excalidraw', 'django'):
        manifest = baseline.verify_manifest(root, corpus)
        project = root / 'projects' / corpus
        shutil.copytree(root / 'corpora' / corpus, project)
        config(project, 'rust')
        output = root / 'results' / corpus
        edits = edit_files(manifest, json.loads((HERE / 'queries' / f'{corpus}.json').read_text()))
        entry = report['corpora'][corpus] = {'manifestSha256': manifest['manifest_sha256'],
                                            'querySha256': manifest['query_sha256'], 'runs': {}}
        for stage in ('fresh', 'unchanged', 'edited', 'restore'):
            if stage == 'edited':
                for edit in edits:
                    path = project / edit['path']
                    marker = b'\n# mimirs benchmark incremental edit\n' if path.suffix in ('.py', '.pyi') else b'\n// mimirs benchmark incremental edit\n'
                    path.write_bytes(path.read_bytes() + marker)
            elif stage == 'restore':
                for edit in edits:
                    shutil.copyfile(root / 'corpora' / corpus / edit['path'], project / edit['path'])
            print('INDEX', corpus, stage, flush=True)
            profile_path = output / f'{stage}-profile.json'
            timing = measure([str(binary), 'index', '--profile', str(profile_path)], project, output / stage)
            profile = json.loads(profile_path.read_text())
            assert profile['complete'] and not profile['counters'].get('files_skipped', 0)
            assert not profile['counters'].get('model_assets_fetched', 0)
            if stage == 'unchanged':
                assert profile['counters']['files_reused'] == len(manifest['manifest'])
                assert not profile['counters'].get('embedding_calls', 0)
            else:
                assert profile['counters']['files_indexed'] == (len(manifest['manifest']) if stage == 'fresh' else 2)
            entry['runs'][stage] = {'timing': timing, 'counters': profile['counters'], 'stages': profile['stages']}
            print('DONE', corpus, stage, round(timing['wall_seconds'], 3), flush=True)
        baseline.verify_project(project, manifest)
        stored = logical_hashes(project / '.mimirs/index.db')
        assert stored == logical_hashes(reference / 'projects' / corpus / '.mimirs/index.db'), 'published data changed'
        entry['storedTableSha256'] = stored
        entry['indexBytes'] = (project / '.mimirs/index.db').stat().st_size
        write(root / 'report.json', report)
        print('PARITY', corpus, 'all published tables and vector bytes exact', flush=True)


if __name__ == '__main__':
    main()
