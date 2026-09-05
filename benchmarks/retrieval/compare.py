#!/usr/bin/env python3
"""Explicit local-model comparison; never run by cargo test."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sqlite3
import tempfile
import time

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent


def command(args, cwd):
    start = time.monotonic()
    result = subprocess.run(args, cwd=cwd, text=True, capture_output=True, check=True)
    return result.stdout, result.stderr, time.monotonic() - start


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--model-snapshot", type=Path, required=True)
    parser.add_argument("--revision", default="425fbbe")
    args = parser.parse_args()
    binary = args.binary.resolve()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    cases = json.loads((HERE / "queries.json").read_text())
    targets = json.loads((HERE / "targets.json").read_text())
    revision = command(["git", "rev-parse", args.revision], REPO)[0].strip()
    files = command(["git", "ls-tree", "-r", "--name-only", revision, "src"], REPO)[0].splitlines()
    files = [file for file in files if file.endswith(".rs")]
    artifacts = {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(args.model_snapshot.iterdir()) if path.is_file()}
    report = {"source_revision": revision, "binary_sha256": hashlib.sha256(binary.read_bytes()).hexdigest(), "model_revision": args.model_snapshot.name, "model_files_sha256": artifacts, "query_sha256": hashlib.sha256((HERE / "queries.json").read_bytes()).hexdigest(), "result_limit": 64, "file_count": len(files), "policies": {}}
    with tempfile.TemporaryDirectory(prefix="mimirs-retrieval-") as temporary:
        for policy in ["raw", "facts"]:
            root = Path(temporary) / policy
            (root / ".mimirs").mkdir(parents=True)
            (root / ".mimirs/config.toml").write_text(f'include = ["**/*.rs"]\nexclude = []\nretrieval = "{policy}"\n')
            corpus_hash = hashlib.sha256()
            for file in files:
                text = subprocess.check_output(["git", "show", f"{revision}:{file}"], cwd=REPO)
                path = root / file
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(text)
                corpus_hash.update(file.encode() + b"\0" + text)
            report["corpus_sha256"] = corpus_hash.hexdigest()
            stdout, stderr, seconds = command([str(binary), "index"], root)
            (output / f"{policy}-index.txt").write_text(stdout + stderr)
            index_summary = stdout
            with sqlite3.connect(f"file:{root / '.mimirs/index.db'}?mode=ro", uri=True) as database:
                metadata = dict(database.execute("SELECT key, value FROM index_metadata"))
                counts = {table: database.execute(f"SELECT count(*) FROM {table}").fetchone()[0] for table in ["retrieval_documents", "windows"]}
            rows = []
            for number, (case, expected) in enumerate(zip(cases, targets)):
                stdout, stderr, elapsed = command([str(binary), "search", case["query"], "--limit", "64"], root)
                (output / f"{policy}-query-{number + 1}.txt").write_text(stdout + stderr)
                paths = re.findall(r"^location: (.*):\d+(?:-\d+)?$", stdout, re.MULTILINE)
                unique = list(dict.fromkeys(paths))
                rank = next((index + 1 for index, path in enumerate(unique) if path in expected), None)
                rows.append({**case, "expected_files": expected, "first_expected_file_rank": rank, "top_five_files": unique[:5], "returned_hits": len(paths), "unique_files_in_returned_hits": len(unique), "seconds": elapsed})
            report["policies"][policy] = {"index_seconds": seconds, "index_summary": index_summary, "metadata": metadata, "counts": counts, "queries": rows}
    after = {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(args.model_snapshot.iterdir()) if path.is_file()}
    if artifacts != after:
        raise RuntimeError("model artifacts changed during comparison")
    (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
