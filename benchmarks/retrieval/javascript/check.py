#!/usr/bin/env python3
"""Check JS/TS fallback upgrades, saved source and frozen mixed-language queries."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


audit = load('audit', HERE.parent / 'compare.py')
mixed = load('mixed', HERE.parent / 'mixed/check.py')


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def saved(root):
    with sqlite3.connect(f'file:{root}/.mimirs/index.db?mode=ro', uri=True) as db:
        db.row_factory = sqlite3.Row
        docs = [dict(r) for r in db.execute('SELECT f.path,d.owner,d.part,d.text,d.evidence FROM retrieval_documents d JOIN files f ON f.id=d.file_id ORDER BY f.path,d.ordinal')]
        owners = [dict(r) for r in db.execute('SELECT f.path,e.*,p.name AS parent_name FROM entities e JOIN files f ON f.id=e.file_id LEFT JOIN entities p ON p.file_id=e.file_id AND p.ordinal=e.parent')]
        versions = dict(db.execute('SELECT f.path,s.analysis_version FROM source_snapshots s JOIN files f ON f.id=s.file_id'))
        metadata = dict(db.execute('SELECT key,value FROM index_metadata'))
    return docs, owners, versions, metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--previous-binary', type=Path, required=True)
    parser.add_argument('--model-snapshot', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    binary, previous, out = args.binary.resolve(), args.previous_binary.resolve(), args.output.resolve()
    out.mkdir(parents=True)
    root = out / 'project'
    shutil.copytree(HERE / 'corpus', root)
    (root / '.mimirs').mkdir()
    config = 'include = ["**/*.rs", "**/*.py", "**/*.pyi", "**/*.ts", "**/*.mts", "**/*.cts", "**/*.tsx", "**/*.js", "**/*.mjs", "**/*.cjs", "**/*.jsx"]\nexclude = []\n'
    (root / '.mimirs/config.toml').write_text(config)
    sources = {p.name: p.read_bytes() for p in sorted((HERE / 'corpus').iterdir())}
    cases = json.loads((HERE / 'queries.json').read_text())
    report = {'binary_sha256': digest(binary), 'previous_binary_sha256': digest(previous), 'query_sha256': digest(HERE / 'queries.json'), 'corpus_sha256': hashlib.sha256(b''.join(p.encode()+b'\0'+s for p,s in sources.items())).hexdigest(), 'model_revision': args.model_snapshot.name, 'model_files_sha256': {p.name:digest(p) for p in args.model_snapshot.iterdir() if p.is_file()}, 'config': config}

    def command(executable, label, *arguments):
        stdout, stderr, seconds = audit.command([str(executable), *arguments], root)
        (out / (label + '.stdout')).write_text(stdout)
        (out / (label + '.stderr')).write_text(stderr)
        return stdout, seconds

    command(previous, 'fallback-index', 'index')
    before, old_owners, old_versions, _ = saved(root)
    extensions = {'.rs', '.py', '.pyi'}
    assert all(Path(e['path']).suffix in extensions for e in old_owners)
    db_hash = digest(root / '.mimirs/index.db')
    rejected = subprocess.run([str(binary), 'search', 'browser tokens'], cwd=root, text=True, capture_output=True)
    assert rejected.returncode != 0 and 'mimirs index' in rejected.stderr
    assert digest(root / '.mimirs/index.db') == db_hash
    report['old_policy_search_rejected_without_write'] = True
    stdout, seconds = command(binary, 'upgrade-index', 'index', '--profile', str(out / 'profile.json'))
    docs, owners, versions, metadata = saved(root)
    assert stdout.startswith(f'indexed: {len(sources)} files\nunchanged: 0 files\n')
    assert [d for d in before if Path(d['path']).suffix in extensions] == [d for d in docs if Path(d['path']).suffix in extensions]
    for path in sources:
        if Path(path).suffix not in extensions:
            assert versions[path] != old_versions[path]
            assert any(e['path'] == path for e in owners)
    report.update({'fallback_documents': len(before), 'documents': len(docs), 'analysis_versions': versions, 'metadata': metadata, 'upgrade_seconds': seconds, 'existing_language_documents_unchanged': True, 'input_audit': audit.audit_inputs(root, sources, docs), 'documents_sha256': hashlib.sha256(json.dumps(docs, sort_keys=True).encode()).hexdigest()})
    profile = json.loads((out / 'profile.json').read_text())
    assert profile['complete'] and profile['embedding_batch_sizes'] == {'1': len(docs)}
    report['embedding_worker_limit'] = profile['counters']['embedding_worker_limit']
    report['embedding_calls'] = profile['counters']['embedding_calls']
    (out / 'inputs.json').write_text(json.dumps(docs, indent=2)+'\n')
    again, _ = command(binary, 'unchanged-index', 'index')
    assert again.startswith(f'indexed: 0 files\nunchanged: {len(sources)} files\n')
    assert saved(root)[0] == docs
    report['unchanged_files_reused'] = len(sources)
    assert (root / '.mimirs/config.toml').read_text() == config
    for path in sources:
        for option in [[], ['--source-chunks']]:
            direct, _, _ = audit.command([str(binary), 'inspect', path, *option], root)
            stored, _, _ = audit.command([str(binary), 'inspect', path, '--stored', *option], root)
            assert direct == stored
        (root / path).unlink()
        after, _, _ = audit.command([str(binary), 'inspect', path, '--stored', '--source-chunks'], root)
        assert stored == after
    report['stored_inspection_after_deletion'] = len(sources)
    report['queries'] = []
    for case in cases:
        stdout, _ = command(binary, case['id'], 'search', case['query'], '--limit', '10')
        hits = mixed.parse(stdout)
        for hit in hits:
            source = sources[hit['path']]
            for chunk in hit['chunks']:
                for start, end, first, last in chunk['spans']:
                    assert 0 <= start < end <= len(source)
                    assert source[start:end].decode() in chunk['text']
                    assert (first, last) == (source[:start].count(b'\n')+1, source[:end-1].count(b'\n')+1)
        targets = [e for e in owners if e['path'] == case['path'] and e['name'] == case['name'] and e['parent_name'] == case['parent'] and ('entity_kind' not in case or e['kind'] == case['entity_kind'])]
        assert len(targets) == 1, case
        hit = next((h for h in hits if h['path'] == case['path'] and h['owner'] == targets[0]['ordinal']), None)
        report['queries'].append({**case, 'rank': hit['rank'] if hit else None, 'visible_answer': bool(hit) and all(any(s in c['text'] for c in hit['chunks']) for s in case['required_snippets']), 'displayed_parts': len(hit['chunks']) if hit else 0})
    # Restore source, then verify mixed-language edits and deletion in the CLI.
    for path, source in sources.items():
        (root / path).write_bytes(source)
    (root / 'cache.ts').write_text('export const replaced = 42;\n')
    (root / 'sessions.py').write_text('def replaced(): return 42\n')
    (root / 'legacy.js').unlink()
    changed, _ = command(binary, 'incremental-index', 'index')
    assert changed.startswith(f'indexed: 2 files\nunchanged: {len(sources)-3} files\n')
    _, changed_owners, _, _ = saved(root)
    assert not any(e['path'] == 'legacy.js' for e in changed_owners)
    assert [e['name'] for e in changed_owners if e['path'] == 'cache.ts'] == ['replaced']
    report['incremental_changed_files'] = 2
    report['incremental_deleted_files'] = 1
    assert report['model_files_sha256'] == {p.name: digest(p) for p in args.model_snapshot.iterdir() if p.is_file()}
    (out / 'report.json').write_text(json.dumps(report, indent=2)+'\n')
    print(json.dumps({'audit':report['input_audit'], 'ranks':[(q['id'],q['rank'],q['visible_answer']) for q in report['queries']]}, indent=2))


if __name__ == '__main__':
    main()
