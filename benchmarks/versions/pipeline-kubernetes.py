#!/usr/bin/env python3
"""Audit a completed Rust Kubernetes run against the preceding checkpoint.

Collection reads retained indexes and CLI responses. Its only index command is
an untimed unchanged-file check; it must perform no inference.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import statistics
import subprocess

from audit import audit
from pipeline import logical_hashes, module
from run import database_info, score, write


def read(path):
    return json.loads(path.read_text())


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def collect(root, reference, output):
    output.mkdir(parents=True, exist_ok=False)
    baseline = module('port-baseline')
    manifest = baseline.verify_manifest(root, 'kubernetes')
    assert manifest == baseline.verify_manifest(reference, 'kubernetes')
    provenance = read(root / 'provenance.json')
    assert digest(root / 'engines/mimirs-rust') == provenance['rustBinarySha256']
    previous = read(reference / 'provenance.json')
    assert digest(reference / 'engines/mimirs-rust') == previous['rustBinarySha256']
    checkpoint = read(Path(__file__).parent / 'port/kubernetes/kubernetes.json')
    assert previous == checkpoint['provenance'], 'reference is not the accepted checkpoint'
    queries = read(Path(__file__).parent / 'queries/kubernetes.json')
    report = {'provenance': provenance, 'referenceProvenance': previous,
              'manifestSha256': manifest['manifest_sha256'],
              'querySha256': manifest['query_sha256'], 'engines': {}}
    fingerprints = {}
    for label, location in (('before', reference), ('after', root)):
        project = location / 'projects/kubernetes-rust-0'
        directory = location / 'results/kubernetes/rust'
        baseline.verify_project(project, manifest)
        complete = read(directory / 'complete.json')
        assert len(complete['trials']) == 1
        assert complete['manifest_sha256'] == manifest['manifest_sha256']
        cases = read(directory / 'rust-cases.json')
        quality = score(queries, cases, manifest['expected_path_corrections'], project)
        assert quality == read(directory / 'quality.json') == complete['quality']
        phases = {stage: read(directory / 'trial-0' / f'{stage}.json')
                  for stage in ('fresh', 'unchanged', 'edited', 'restore')}
        timings = [read(directory / 'search' / f'0-{i}.json') for i in range(len(queries))]
        assert all(row['exit_code'] == 0 for row in [*phases.values(), *timings])
        assert all(row['command'][-2:] == ['--limit', '20'] for row in timings)
        info = database_info(project, 'rust', manifest)
        assert not info['missing_files'] and not info['extra_files']
        fingerprints[label] = logical_hashes(project / '.mimirs/index.db')
        cli = read(directory / 'cli.json')
        report['engines'][label] = {
            'phases': phases, 'database': info, 'quality': quality,
            'editPaths': complete['trials'][0]['edit_paths'],
            'queryProcessesSeconds': sum(row['wall_seconds'] for row in timings),
            'cliSamples': len(cli),
            'cliMedianSeconds': statistics.median(row['wall_seconds'] for row in cli),
            'artifactHashes': {name: digest(directory / name)
                               for name in ('complete.json', 'quality.json', 'cli.json')}}
    assert fingerprints['before'] == fingerprints['after'], 'stored index changed'
    before, after = (report['engines'][key] for key in ('before', 'after'))
    assert before['quality'] == after['quality'], 'retrieval scores or rankings changed'
    assert before['editPaths'] == after['editPaths'], 'incremental targets changed'
    normalize = lambda text: re.sub(r'(?m)^time: [^\n]+$', 'time: ignored', text, count=1)
    for i in range(len(queries)):
        path = Path('results/kubernetes/rust/search') / f'0-{i}.stdout'
        assert normalize((root / path).read_text()) == normalize((reference / path).read_text()), f'CLI response changed: {i}'
    project = root / 'projects/kubernetes-rust-0'
    profile_path = output / 'unchanged-profile.json'
    subprocess.run([str(root / 'engines/mimirs-rust'), 'index', '--profile', str(profile_path)],
                   cwd=project, capture_output=True, check=True)
    profile = read(profile_path)
    assert profile['complete'] and profile['counters']['files_reused'] == len(manifest['manifest'])
    assert not profile['counters'].get('embedding_calls', 0)
    assert not profile['counters'].get('files_indexed', 0)
    report['unchangedVerification'] = {
        'complete': profile['complete'], 'counters': profile['counters'],
        'profileSha256': digest(profile_path), 'retainedProfilePath': str(profile_path)}
    report.update(
        storedTableSha256=fingerprints['after'], responseMismatches=0,
        evidence=audit(project, read(root / 'results/kubernetes/rust/rust-cases.json')),
        runnerWall=read(root / 'runner-wall.json'),
        freshSpeedup=before['phases']['fresh']['wall_seconds'] / after['phases']['fresh']['wall_seconds'],
        timingScope='One new Rust trial compared with the earlier accepted Rust trial on the same host and corpus. Cached model assets, three inference workers, unprofiled fresh indexes. Timed fresh, unchanged, edited, restored indexes and all 120 cold CLI queries run sequentially. Correctness audits are outside measured commands. The baseline was retained, not rerun alongside the candidate.')
    write(output / 'kubernetes.json', report)
    (output / 'KUBERNETES.md').write_text(markdown(report))
    print(json.dumps({'freshSeconds': after['phases']['fresh']['wall_seconds'],
                      'freshSpeedup': report['freshSpeedup'], 'responseMismatches': 0,
                      'storedTablesMatched': len(fingerprints['after']), 'evidence': report['evidence']}), flush=True)


def markdown(report):
    before, after = (report['engines'][label] for label in ('before', 'after'))
    old = before['phases']['fresh']['wall_seconds']
    new = after['phases']['fresh']['wall_seconds']
    lines = ['# Kubernetes after persistent workers', '',
             f'Fresh indexing took {new:.2f} seconds, down from {old:.2f} seconds. This saves {old-new:.2f} seconds, or {(1-new/old)*100:.1f}% of elapsed time. The 11-minute target remains open.', '',
             '| Operation | Previous s | Persistent workers s |',
             '| --- | ---: | ---: |']
    for stage in ('fresh', 'unchanged', 'edited', 'restore'):
        lines.append(f"| {stage} | {before['phases'][stage]['wall_seconds']:.3f} | {after['phases'][stage]['wall_seconds']:.3f} |")
    lines += ['', '| Cost | Previous | Persistent workers |', '| --- | ---: | ---: |']
    for name, get in (
        ('Fresh user + system CPU seconds', lambda e: e['phases']['fresh']['user_seconds'] + e['phases']['fresh']['system_seconds']),
        ('Fresh peak RSS MiB', lambda e: e['phases']['fresh']['peak_rss_bytes'] / 2**20),
        ('All 120 cold CLI queries, seconds', lambda e: e['queryProcessesSeconds']),
        ('Ten fixed cold CLI samples, median seconds', lambda e: e['cliMedianSeconds']),
        ('Index MiB', lambda e: e['database']['index_bytes'] / 2**20)):
        lines.append(f'| {name} | {get(before):.3f} | {get(after):.3f} |')
    lines += ['', report['timingScope'], '',
              'Both runs use the pinned 8,790-file corpus on the same Apple M2 Pro with 10 logical CPUs and 32 GiB memory. The new binary retains three singleton inference workers and allows at most six pending files. Coordinator work can overlap inference, so this is not a hard CPU quota.', '',
              'All 134,363 stored document vectors and the other rows in the 11 audited tables are byte-identical after the same edit/restore cycle. This covers source snapshots, chunks, document text, owner links, processing metadata, and vector storage. All 120 CLI responses match exactly after normalizing only elapsed time. The unchanged verification performs no inference. The source evidence audit also passes.', '',
              'The previous checkpoint already matched TS v2 rankings and passed the source/vector checks. This run compares against that retained Rust checkpoint; it does not rerun TS. File-label retrieval scores do not measure answer correctness.', '',
              'Fresh indexing improved substantially in this trial while total CPU work changed little. Unchanged indexing was slower in this sample; edited and restored indexing stayed close to the earlier times. These are single trials from separate runs, so small timing differences and memory differences should not be generalized.', '',
              f"The Rust runner took {report['runnerWall']['wallSeconds']:.2f} seconds including corpus copying, four index commands, all 120 search commands, and collection of their results. The additional storage and evidence audits are excluded from that time.", '',
              'The [JSON report](kubernetes.json) records binary hashes, revisions, manifest/query hashes, exact table hashes, quality results, timings, and the evidence audit. The [previous checkpoint](../../port/kubernetes/KUBERNETES.md) and [development-corpus experiment](../PIPELINE.md) retain their original measurements.', '',
              'To reproduce, copy the candidate binary to a new runner root as `engines/mimirs-rust`, link its `corpora` directory to the retained pinned corpora, and record the binary and host provenance. Run `run.py --root ROOT --corpora kubernetes --versions rust --repeats 1 --rust-limit 20`. Record whole-run wall time separately as `runner-wall.json`. Then collect without repeating inference using `pipeline-kubernetes.py --root ROOT --reference-root PREVIOUS_ROOT --output NEW_DIRECTORY`.', '']
    return '\n'.join(lines)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--reference-root', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    collect(args.root.resolve(), args.reference_root.resolve(), args.output.resolve())
