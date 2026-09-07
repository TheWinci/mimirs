#!/usr/bin/env python3
"""Compare bounded indexing with the preceding binary on the pinned dev corpora.

Alternating order, cached model assets, three inference workers, separate fresh
projects. Corpus/queries are unchanged. Kubernetes is excluded from this pilot.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import platform
import subprocess
import sqlite3
import statistics

from run import config, edit_files, measure, write

HERE = Path(__file__).resolve().parent


def module(name):
    spec = importlib.util.spec_from_file_location(name, HERE / f"{name}.py")
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def logical_hashes(database):
    """Exact logical storage, including evidence, owner links and vector bytes."""
    tables = ("files", "source_snapshots", "entities", "analysis_records", "source_chunks",
              "retrieval_documents", "retrieval_processing", "index_metadata",
              "document_embeddings_rowids", "document_embeddings_chunks", "document_embeddings_vector_chunks00")
    result = {}
    with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as db:
        for table in tables:
            digest = hashlib.sha256()
            for row in db.execute(f'SELECT * FROM "{table}" ORDER BY 1'):
                for value in row:
                    data = value if isinstance(value, bytes) else json.dumps(value, ensure_ascii=False).encode()
                    digest.update(len(data).to_bytes(8, 'little'))
                    digest.update(data)
            result[table] = digest.hexdigest()
    return result


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--root', type=Path, required=True)
    p.add_argument('--reference-root', type=Path, required=True)
    p.add_argument('--before', type=Path, required=True)
    p.add_argument('--after', type=Path, required=True)
    p.add_argument('--corpora', nargs='+', choices=('mimirs', 'excalidraw', 'django'), required=True)
    p.add_argument('--repeats', type=int, default=3)
    args = p.parse_args()
    root = args.root.resolve()
    root.mkdir(parents=True, exist_ok=False)
    (root / 'corpora').symlink_to(args.reference_root.resolve() / 'corpora')
    (root / 'engines').mkdir()
    binaries = {}
    for label in ('before', 'after'):
        binary = root / 'engines' / label
        shutil.copy2(getattr(args, label), binary)
        binaries[label] = binary
    baseline = module('port-baseline')
    report = {'binarySha256': {label: hashlib.sha256(binary.read_bytes()).hexdigest() for label, binary in binaries.items()},
              'workers': 3, 'repeats': args.repeats, 'profiled': True,
              'host': {'platform': platform.platform(), 'cpu': subprocess.check_output(['sysctl', '-n', 'machdep.cpu.brand_string'], text=True).strip()},
              'timingScope': 'Alternating before/after order; cached model assets; fresh disposable indexes. Incremental checks run after all timed fresh trials. Source and storage audits are outside measured calls.',
              'corpora': {}}
    for corpus in args.corpora:
        manifest = baseline.verify_manifest(root, corpus)
        rows = []
        fingerprints = {}
        for repeat in range(args.repeats):
            for label in (('before', 'after') if repeat % 2 == 0 else ('after', 'before')):
                project = root / 'projects' / f'{corpus}-{label}-{repeat}'
                shutil.copytree(root / 'corpora' / corpus, project)
                config(project, 'rust')
                output = root / 'results' / corpus / label / str(repeat)
                output.mkdir(parents=True)
                print('INDEX', corpus, label, repeat, flush=True)
                timing = measure([str(binaries[label]), 'index', '--profile', str(output / 'profile.json')], project, output / 'fresh')
                profile = json.loads((output / 'profile.json').read_text())
                assert profile['complete'] and profile['counters']['files_indexed'] == len(manifest['manifest'])
                assert not profile['counters'].get('files_skipped', 0)
                assert not profile['counters'].get('model_assets_fetched', 0), 'uncached model run'
                baseline.verify_project(project, manifest)
                fingerprints[label, repeat] = logical_hashes(project / '.mimirs/index.db')
                if len(fingerprints) > 1:
                    assert fingerprints[label, repeat] == next(iter(fingerprints.values())), 'persisted index differs'
                rows.append({'label': label, 'repeat': repeat, 'fresh': timing, 'counters': profile['counters'], 'phases': profile['phases_seconds']})
                print('DONE', corpus, label, repeat, round(timing['wall_seconds'], 3), flush=True)
        increments = {}
        for label in ('before', 'after'):
            project = root / 'projects' / f'{corpus}-{label}-0'
            output = root / 'results' / corpus / label / 'incremental'
            output.mkdir()
            increments[label] = {}
            for stage in ('unchanged', 'edited', 'restore'):
                edits = edit_files(manifest, json.loads((HERE / 'queries' / f'{corpus}.json').read_text()))
                if stage == 'edited':
                    for entry in edits:
                        path = project / entry['path']
                        marker = b'\n# mimirs benchmark incremental edit\n' if path.suffix in ('.py', '.pyi') else b'\n// mimirs benchmark incremental edit\n'
                        path.write_bytes(path.read_bytes() + marker)
                elif stage == 'restore':
                    for entry in edits:
                        shutil.copyfile(root / 'corpora' / corpus / entry['path'], project / entry['path'])
                timing = measure([str(binaries[label]), 'index', '--profile', str(output / f'{stage}-profile.json')], project, output / stage)
                profile = json.loads((output / f'{stage}-profile.json').read_text())
                assert profile['complete']
                if stage == 'unchanged':
                    assert profile['counters']['files_reused'] == len(manifest['manifest'])
                    assert profile['counters'].get('embedding_calls', 0) == 0
                else:
                    assert profile['counters']['files_indexed'] == 2
                increments[label][stage] = timing
            baseline.verify_project(project, manifest)
        restored = logical_hashes(root / 'projects' / f'{corpus}-before-0/.mimirs/index.db')
        assert restored == logical_hashes(root / 'projects' / f'{corpus}-after-0/.mimirs/index.db')
        medians = {label: statistics.median(row['fresh']['wall_seconds'] for row in rows if row['label'] == label) for label in binaries}
        report['corpora'][corpus] = {'manifestSha256': manifest['manifest_sha256'], 'querySha256': manifest['query_sha256'],
            'trials': rows, 'freshMedianSeconds': medians, 'speedup': medians['before'] / medians['after'],
            'identicalStoredTables': list(next(iter(fingerprints.values()))),
            'freshStoredTableSha256': next(iter(fingerprints.values())),
            'restoredStoredTableSha256': restored, 'incremental': increments}
        write(root / 'comparison.json', report)
        print('COMPARISON', corpus, medians, 'speedup', report['corpora'][corpus]['speedup'], flush=True)


if __name__ == '__main__':
    main()
