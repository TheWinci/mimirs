#!/usr/bin/env python3
"""Freeze validated TS v2 and q8 Rust results for the three development corpora."""
import argparse
import hashlib
import json
from pathlib import Path
import platform
import sqlite3
import statistics
import subprocess

from audit import audit
from parity import check as check_cli_parity
from run import score

HERE = Path(__file__).resolve().parent
RUST = '0b767fde2b870270ef26c2fd3c1f770b1da55fd7'
TS = '122674c8bfbbc3549390743f51396c5f0e4e3537'
CORPORA = ('mimirs', 'excalidraw', 'django')


def read(path):
    return json.loads(path.read_text())


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def verify_manifest(root, corpus):
    manifest = read(root / 'corpora' / f'{corpus}.json')
    canonical = json.dumps(manifest['manifest'], sort_keys=True).encode()
    require(hashlib.sha256(canonical).hexdigest() == manifest['manifest_sha256'], 'invalid manifest hash')
    require(digest(HERE / 'queries' / f'{corpus}.json') == manifest['query_sha256'], 'queries changed')
    require(manifest == read(HERE / 'results' / f'{corpus}-manifest.json'), 'corpus definition changed')
    return manifest


def verify_project(project, manifest):
    expected = {row['path']: row['sha256'] for row in manifest['manifest']}
    actual = {p.relative_to(project).as_posix(): digest(p) for p in project.rglob('*')
              if p.is_file() and '.mimirs' not in p.relative_to(project).parts}
    require(actual == expected, f'{project}: working source differs from the frozen corpus')


def freeze_pair(root, corpus, version):
    manifest = verify_manifest(root, corpus)
    directory = root / 'results' / corpus / version
    complete = read(directory / 'complete.json')
    require(complete['manifest_sha256'] == manifest['manifest_sha256'], 'run used a different manifest')
    project = root / 'projects' / f'{corpus}-{version}-0'
    verify_project(project, manifest)
    quality = read(directory / 'quality.json')
    queries = read(HERE / 'queries' / f'{corpus}.json')
    cases = read(directory / 'rust-cases.json') if version == 'rust' else read(directory / 'warm.json')['cases']
    require(score(queries, cases, manifest['expected_path_corrections'], project) == quality, 'saved scores differ from raw rankings')
    require(complete['quality'] == quality, 'completed run and quality file disagree')
    if version == 'v2':
        require(quality == read(HERE / 'results' / f'{corpus}-v2-quality.json'), 'reference scores changed')
        parity = check_cli_parity(root, corpus, version)
        require(parity and all(row['matches'] for row in parity), 'TS CLI/API ranking mismatch')
        validation = {'saved_cli_api_checks': len(parity), 'mismatches': 0}
    else:
        validation = audit(project, cases)
        if corpus == 'mimirs':
            pilot = read(HERE.parent / 'index/quantized-results.json')['paired_queries']['cases']
            require(len(pilot) == len(quality['cases']), 'q8 pilot query count differs')
            require(all(a['query'] == b['query'] and a['paths'] == b['q8_files']
                        for a, b in zip(quality['cases'], pilot)), 'production q8 rankings differ from the saved pilot')
            validation['production_pilot_rankings_verified'] = len(pilot)
    trials = complete['trials']
    for trial in trials:
        require(not trial['database']['missing_files'] and not trial['database']['extra_files'], 'incomplete file coverage')
    # Fingerprint stored retrieval text independently of vectors and DB ids.
    # TS adds its path projection/subwindows later; this is not a vector hash.
    database = project / '.mimirs' / ('index.db' if version == 'rust' else 'index.sqlite')
    with sqlite3.connect(f'file:{database}?mode=ro', uri=True) as connection:
        if version == 'v2':
            stored = dict(connection.execute('SELECT path,content_hash FROM files'))
            normalized_hashes = {}
            for entry in manifest['manifest']:
                source = (project / entry['path']).read_bytes().decode('utf-8')
                source = source.removeprefix('\ufeff').replace('\r\n', '\n').replace('\r', '\n')
                normalized_hashes[entry['path']] = hashlib.sha256(source.encode()).hexdigest()
            require(stored == normalized_hashes, 'TS index snapshots differ from normalized corpus')
        query = ('SELECT f.path,d.ordinal,d.text FROM retrieval_documents d JOIN files f ON f.id=d.file_id ORDER BY f.path,d.ordinal'
                 if version == 'rust' else
                 'SELECT f.path,w.ordinal,w.text FROM source_windows w JOIN source_chunks c ON c.id=w.source_chunk_id JOIN files f ON f.id=c.file_id ORDER BY f.path,c.start_offset,w.ordinal,w.id')
        rows = list(connection.execute(query))
        inputs_hash = hashlib.sha256(json.dumps(rows, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
        metadata = dict(connection.execute('SELECT * FROM index_metadata')) if version == 'rust' else None
        if metadata is not None:
            require(metadata.get('embedding_model', '').startswith('all-MiniLM-L6-v2-q8@'), 'Rust index is not the production q8 baseline')
    cli = read(directory / 'cli.json')
    return {
        'corpus': corpus, 'version': version, 'source_revision': RUST if version == 'rust' else TS,
        'manifest_sha256': manifest['manifest_sha256'], 'query_sha256': manifest['query_sha256'],
        'source_windows': len(rows), 'stored_retrieval_text_sha256': inputs_hash, 'index_metadata': metadata,
        'quality': quality, 'validation': validation,
        'timing_runs': len(trials),
        'timing_seconds': {phase: statistics.median(t[phase]['wall_seconds'] for t in trials) for phase in ('fresh', 'unchanged', 'edited')},
        'cli_sample_ms_median': statistics.median(row['wall_seconds'] * 1000 for row in cli),
        'peak_rss_bytes': max(t['fresh']['peak_rss_bytes'] for t in trials),
        'index_bytes': trials[0]['database']['index_bytes'],
        'raw_directory': str(directory),
        'artifact_hashes': {name: digest(directory / name) for name in ('complete.json', 'quality.json', 'cli.json')},
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True, help='completed q8 runs with one or more trials')
    parser.add_argument('--reference-root', type=Path, required=True, help='retained pinned TS v2 comparison')
    parser.add_argument('--output', type=Path, required=True, help='new durable output directory')
    args = parser.parse_args()
    require(not args.output.exists(), 'output already exists')
    provenance = read(args.root / 'provenance.json')
    require(provenance['source_revision'] == RUST, 'wrong Rust revision')
    require(digest(args.root / 'engines/mimirs-rust') == provenance['binary_sha256'], 'Rust binary changed')
    reference_provenance = read(args.reference_root / 'provenance.json')
    require(reference_provenance['v2_revision'] == TS, 'wrong TS reference')
    pairs = [freeze_pair(root, corpus, version) for corpus in CORPORA
             for root, version in ((args.reference_root, 'v2'), (args.root, 'rust'))]
    result = {
        'rust_provenance': provenance, 'ts_provenance': reference_provenance,
        'measurement_host': {'platform': platform.platform(), 'cpu': subprocess.check_output(['sysctl', '-n', 'machdep.cpu.brand_string'], text=True).strip()},
        'reference_fixture_sha256': digest(HERE / 'port/reference.json'),
        'query_files': {corpus: digest(HERE / 'queries' / f'{corpus}.json') for corpus in (*CORPORA, 'kubernetes')},
        'deferred': ['kubernetes'], 'pairs': pairs,
    }
    args.output.mkdir(parents=True)
    (args.output / 'baseline.json').write_text(json.dumps(result, indent=2) + '\n')
    lines = ['# Retrieval port baseline', '',
             'Frozen TS v2 reference and pre-port q8 Rust. Kubernetes is deferred.', '',
             '| Corpus | Engine | R@5 | R@10 | R@20 | MRR@20 | Misses | Fresh s | Peak MiB | Timing trials |',
             '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |']
    for pair in pairs:
        q = pair['quality']
        lines.append(f"| {pair['corpus']} | {pair['version']} | {q['recall@5']:.4f} | {q['recall@10']:.4f} | {q['recall@20']:.4f} | {q['mrr@20']:.4f} | {q['misses@20']} | {pair['timing_seconds']['fresh']:.2f} | {pair['peak_rss_bytes']/2**20:.0f} | {pair['timing_runs']} |")
    lines += ['', 'TS rows reuse the previous three-trial measurements. Rust rows use one',
              'fresh, unchanged, and edited index trial per corpus, with cached model assets',
              'and three embedding workers. These are descriptive baseline timings, not',
              'isolated performance claims. Lightweight fixture capture and source inspection',
              'took place during the Rust run; no second model workload ran concurrently.', '',
              'All source manifests and restored working files were checked. TS raw rankings',
              'were rescored and saved CLI/API samples verified. Rust saved source and',
              'displayed evidence were audited. The JSON retains per-query file rankings,',
              'identity/input hashes, validation summaries, and raw artifact locations.', '',
              'The original queries label files, not answers. TS returns twenty files; the',
              'pre-port Rust baseline returns up to one hundred owners and collapses those',
              'to twenty files for scoring. This is not an equal candidate or output budget.',
              'The two engines also differ in source windows and embedding policy.']
    (args.output / 'BASELINE.md').write_text('\n'.join(lines) + '\n')
    print(f'Validated {len(pairs)} engine/corpus pairs; Kubernetes deferred.')


if __name__ == '__main__':
    main()
