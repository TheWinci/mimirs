#!/usr/bin/env python3
"""Check Python source retrieval and saved evidence using the pinned real model."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from compare import audit_inputs, command

HERE = Path(__file__).resolve().parent


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def saved(root):
    with sqlite3.connect(f"file:{root / '.mimirs/index.db'}?mode=ro", uri=True) as db:
        db.row_factory = sqlite3.Row
        inputs = [dict(row) for row in db.execute(
            "SELECT f.path, d.owner, d.part, d.text, d.evidence FROM retrieval_documents d "
            "JOIN files f ON f.id=d.file_id ORDER BY f.path, d.ordinal")]
        owners = {(row['path'], row['ordinal']): dict(row) for row in db.execute(
            "SELECT f.path, e.ordinal, e.name, p.name AS parent, e.line_start, e.line_end "
            "FROM entities e JOIN files f ON f.id=e.file_id "
            "LEFT JOIN entities p ON p.file_id=e.file_id AND p.ordinal=e.parent")}
        metadata = dict(db.execute("SELECT key, value FROM index_metadata"))
        versions = dict(db.execute("SELECT f.path, s.analysis_version FROM source_snapshots s JOIN files f ON f.id=s.file_id"))
        return inputs, owners, metadata, versions


def hits(stdout, owners, sources):
    output = []
    for block in re.split(r"\nresult: \d+/\d+\n", stdout)[1:]:
        location = re.search(r"^location: (.*):(\d+)(?:-(\d+))?$", block, re.MULTILINE)
        path, start, end = location.groups()
        owner = re.search(r"^owner: (file|e\d+)$", block, re.MULTILINE).group(1)
        ordinal = None if owner == 'file' else int(owner[1:])
        entity = owners.get((path, ordinal), {})
        source = sources[path]
        snapshot = re.search(r"^source: indexed snapshot (\w+)$", block, re.MULTILINE).group(1)
        assert snapshot == hashlib.sha256(source).hexdigest()
        evidence = []
        for a, b, first, last in re.findall(r"^evidence: Source bytes (\d+)\.\.(\d+) lines (\d+)\.\.(\d+)$", block, re.MULTILINE):
            a, b, first, last = map(int, (a, b, first, last))
            assert 0 <= a < b <= len(source)
            source[a:b].decode('utf-8')
            assert first == source[:a].count(b'\n') + 1
            assert last == source[:b-1].count(b'\n') + 1
            evidence.append({'start': a, 'end': b, 'line_start': first, 'line_end': last})
        assert evidence
        if ordinal is not None:
            assert entity and (int(start), int(end or start)) == (entity['line_start'], entity['line_end'])
        output.append({'path': path, 'owner': ordinal, 'name': entity.get('name'),
                       'parent': entity.get('parent'), 'evidence': evidence})
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--previous-binary', type=Path)
    parser.add_argument('--model-snapshot', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    binary = args.binary.resolve()
    previous = args.previous_binary.resolve() if args.previous_binary else None
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    cases = json.loads((HERE / 'queries.json').read_text())
    files = sorted(p.name for p in (HERE / 'corpus').iterdir() if p.is_file())
    sources = {p: (HERE / 'corpus' / p).read_bytes() for p in files}
    model_hashes = {p.name: digest(p) for p in sorted(args.model_snapshot.iterdir()) if p.is_file()}
    corpus_hash = hashlib.sha256()
    for path, source in sources.items():
        corpus_hash.update(path.encode() + b'\0' + source)
    report = {'binary_sha256': digest(binary), 'model_revision': args.model_snapshot.name,
              'model_files_sha256': model_hashes, 'corpus_sha256': corpus_hash.hexdigest(),
              'queries_sha256': digest(HERE / 'queries.json')}
    with tempfile.TemporaryDirectory(prefix='mimirs-python-check-') as temporary:
        root = Path(temporary)
        shutil.copytree(HERE / 'corpus', root, dirs_exist_ok=True)
        (root / '.mimirs').mkdir()
        config = 'include = ["**/*.rs", "**/*.py", "**/*.pyi"]\nexclude = []\n'
        (root / '.mimirs/config.toml').write_text(config)
        if previous:
            command([str(previous), 'index'], root)
            old_inputs, old_owners, _, old_versions = saved(root)
            assert all(not p.endswith(('.py', '.pyi')) for p, _ in old_owners)
            assert all(d['owner'] is None for d in old_inputs if d['path'].endswith(('.py', '.pyi')))
            rejected = subprocess.run([str(binary), 'search', 'sessions'], cwd=root, capture_output=True, text=True)
            assert rejected.returncode != 0 and 'mimirs index' in rejected.stderr
            report['fallback_upgrade'] = {'previous_binary_sha256': digest(previous), 'before_documents': len(old_inputs)}
        stdout, stderr, _ = command([str(binary), 'index'], root)
        (output / 'index.txt').write_text(stdout + stderr)
        inputs, owners, metadata, versions = saved(root)
        report['metadata'] = metadata
        report['analysis_versions'] = versions
        report['input_audit'] = audit_inputs(root, files, inputs)
        input_text = json.dumps(inputs, ensure_ascii=False, indent=2) + '\n'
        (output / 'inputs.json').write_text(input_text)
        report['inputs_sha256'] = hashlib.sha256(input_text.encode()).hexdigest()
        report['documents'] = len(inputs)
        if previous:
            assert all(versions[p] != old_versions[p] for p in files if p.endswith(('.py', '.pyi')))
            assert all(any(path == p for path, _ in owners) for p in files)
            report['fallback_upgrade']['after_documents'] = len(inputs)
            report['fallback_upgrade']['unchanged_python_gained_owners'] = True
        again, _, _ = command([str(binary), 'index'], root)
        assert again.startswith(f'indexed: 0 files\nunchanged: {len(files)} files\n')
        assert saved(root)[0] == inputs
        assert (root / '.mimirs/config.toml').read_text() == config
        report['unchanged_files_reused'] = len(files)
        for path in files:
            for option in [[], ['--source-chunks']]:
                direct, _, _ = command([str(binary), 'inspect', path, *option], root)
                stored, _, _ = command([str(binary), 'inspect', path, '--stored', *option], root)
                assert stored == direct
                # Delete after both modes have been compared below.
            (root / path).unlink()
            after, _, _ = command([str(binary), 'inspect', path, '--stored', '--source-chunks'], root)
            assert after == stored
        report['stored_inspection_after_deletion'] = len(files)
        report['queries'] = []
        for number, case in enumerate(cases, 1):
            stdout, stderr, _ = command([str(binary), 'search', case['query'], '--limit', '10'], root)
            (output / f'query-{number}.txt').write_text(stdout + stderr)
            rows = hits(stdout, owners, sources)
            rank = next((i for i, row in enumerate(rows, 1)
                         if all(row[k] == case[k] for k in ('path', 'name', 'parent'))), None)
            report['queries'].append({**case, 'expected_owner_rank': rank, 'top_ten': rows})
    assert model_hashes == {p.name: digest(p) for p in sorted(args.model_snapshot.iterdir()) if p.is_file()}
    (output / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'documents': report['documents'], 'audit': report['input_audit'],
                      'ranks': [q['expected_owner_rank'] for q in report['queries']],
                      'fallback_upgrade': report.get('fallback_upgrade')}, indent=2))


if __name__ == '__main__':
    main()
