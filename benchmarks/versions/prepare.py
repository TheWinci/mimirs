#!/usr/bin/env python3
"""Freeze source-only corpora and original queries for the three-version check."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tarfile

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
PINS = {
    'mimirs': ('mimirs', 'd40b90296ef770e6a3c0610eb4002fcabaae025e', {'.ts'}),
    'excalidraw': ('excalidraw', '33721492771919e8569964fe0b034a9cf7f25955', {'.ts', '.tsx', '.js', '.jsx'}),
    'django': ('django', '4bbc27c8686f10f9556cef02dbfa9f5157fbcf56', {'.py', '.pyi'}),
    'kubernetes': ('kubernetes', '9fa4c1cfa3d761fad081ef413d0dc0f88b5569a9', {'.go'}),
}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repos', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=True)
    for name, (directory, revision, extensions) in PINS.items():
        root = out / name
        if root.exists() and any(root.iterdir()):
            previous_path = out / (name + '.json')
            if not previous_path.exists():
                raise RuntimeError(f'{root}: incomplete output; choose a new output directory')
            previous = json.loads(previous_path.read_text())
            queries = (HERE / 'queries' / (name + '.json')).read_bytes()
            expected_corrections = json.loads((HERE / 'corrections.json').read_text()).get(name,{})
            if previous['revision'] != revision or previous['query_sha256'] != sha(queries) or previous['expected_path_corrections'] != expected_corrections:
                raise RuntimeError(f'{root}: inputs changed; choose a new output directory')
            actual = {p.relative_to(root).as_posix():sha(p.read_bytes()) for p in root.rglob('*') if p.is_file()}
            if actual != {f['path']:f['sha256'] for f in previous['manifest']}:
                raise RuntimeError(f'{root}: existing source differs from manifest')
            print(name, previous['files'], previous['bytes'], previous['query_count'], 'verified existing', flush=True)
            continue
        root.mkdir(exist_ok=True)
        data = subprocess.check_output(['git', '-C', str(args.repos / directory), 'archive', revision])
        manifest = []
        with tarfile.open(fileobj=io.BytesIO(data)) as archive:
            for entry in archive:
                path = Path(entry.name)
                if not entry.isfile() or path.suffix not in extensions:
                    continue
                if name == 'mimirs' and path.parts[0] != 'src':
                    continue
                if any(part in {'node_modules', 'vendor', 'dist', 'build', '.git'} for part in path.parts[:-1]):
                    continue
                if name == 'kubernetes' and (path.name.endswith('_test.go') or path.parts[0] in {'test', 'third_party', 'hack'}):
                    continue
                source = archive.extractfile(entry).read()
                source.decode('utf-8')
                target = root / path
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(source)
                manifest.append({'path':path.as_posix(), 'bytes':len(source), 'sha256':sha(source)})
        manifest.sort(key=lambda row: row['path'])
        queries = (HERE / 'queries' / (name + '.json')).read_bytes()
        paths = {row['path'] for row in manifest}
        corrections = json.loads((HERE / 'corrections.json').read_text()).get(name, {})
        missing = [(q['query'], p) for q in json.loads(queries) for p in q['expected'] if corrections.get(p, p) not in paths]
        if missing:
            raise RuntimeError(f'{name}: expected paths absent from fixed manifest: {missing}')
        record = {'name':name, 'expected_path_corrections':corrections, 'revision':revision, 'extensions':sorted(extensions), 'files':len(manifest), 'bytes':sum(r['bytes'] for r in manifest), 'query_count':len(json.loads(queries)), 'query_sha256':sha(queries), 'manifest_sha256':sha(json.dumps(manifest,sort_keys=True).encode()), 'manifest':manifest}
        (out / (name + '.json')).write_text(json.dumps(record,indent=2)+'\n')
        print(name, record['files'], record['bytes'], record['query_count'], flush=True)


if __name__ == '__main__':
    main()
