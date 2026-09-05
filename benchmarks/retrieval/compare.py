#!/usr/bin/env python3
"""Audit source-chunk retrieval with the cached model; never run by cargo test."""
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


def audit_inputs(root, files, inputs):
    """Check actual saved embedding text against the pinned source bytes."""
    spans = {file: [] for file in files}
    signatures = 0
    for document in inputs:
        source = (root / document["path"]).read_bytes()
        evidence = json.loads(document["evidence"])
        if not evidence:
            raise RuntimeError("document without source evidence")
        for index, item in enumerate(evidence):
            span = item["span"]
            start, end = span["start"], span["end"]
            if item["record"] != "Source" or not 0 <= start < end <= len(source):
                raise RuntimeError("invalid source evidence")
            fragment = source[start:end].decode("utf-8")
            if span["line_start"] != source[:start].count(b"\n") + 1 or span["line_end"] != source[:end - 1].count(b"\n") + 1:
                raise RuntimeError("evidence line range mismatch")
            if index == 0:
                if not document["text"].endswith(fragment):
                    raise RuntimeError("embedding body differs from source")
                body = fragment
                spans[document["path"]].append((start, end))
            else:
                if fragment not in document["text"][:-len(body)]:
                    raise RuntimeError("repeated signature differs from source")
                signatures += 1
    for file, ranges in spans.items():
        source = (root / file).read_bytes()
        previous = 0
        for start, end in sorted(ranges):
            if start < previous or source[previous:start].decode("utf-8").strip():
                raise RuntimeError(f"lost or duplicated source in {file}")
            previous = end
        if source[previous:].decode("utf-8").strip():
            raise RuntimeError(f"lost source at end of {file}")
    return {"files": len(files), "documents": len(inputs), "repeated_signatures": signatures,
            "nonblank_source_coverage": "complete", "source_bytes_and_line_ranges": "exact"}


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
        policy = "source"
        root = Path(temporary) / policy
        (root / ".mimirs").mkdir(parents=True)
        (root / ".mimirs/config.toml").write_text('include = ["**/*.rs"]\nexclude = []\n')
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
            counts = {table: database.execute(f"SELECT count(*) FROM {table}").fetchone()[0] for table in ["retrieval_documents"]}
            database.row_factory = sqlite3.Row
            inputs = database.execute("SELECT f.path, d.owner, d.part, d.text, d.evidence FROM retrieval_documents d JOIN files f ON f.id=d.file_id ORDER BY f.path, d.ordinal")
            inputs = [dict(row) for row in inputs]
            audit = audit_inputs(root, files, inputs)
            input_text = json.dumps(inputs, ensure_ascii=False, indent=2) + "\n"
            (output / f"{policy}-inputs.json").write_text(input_text)
        rows = []
        for number, (case, expected) in enumerate(zip(cases, targets)):
            stdout, stderr, elapsed = command([str(binary), "search", case["query"], "--limit", "64"], root)
            (output / f"{policy}-query-{number + 1}.txt").write_text(stdout + stderr)
            paths = re.findall(r"^location: (.*):\d+(?:-\d+)?$", stdout, re.MULTILINE)
            unique = list(dict.fromkeys(paths))
            rank = next((index + 1 for index, path in enumerate(unique) if path in expected), None)
            rows.append({**case, "expected_files": expected, "first_expected_file_rank": rank, "top_five_files": unique[:5], "returned_hits": len(paths), "unique_files_in_returned_hits": len(unique), "seconds": elapsed})
        report["policies"][policy] = {"index_seconds": seconds, "index_summary": index_summary, "metadata": metadata, "counts": counts, "inputs_sha256": hashlib.sha256(input_text.encode()).hexdigest(), "input_audit": audit, "queries": rows}
    after = {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(args.model_snapshot.iterdir()) if path.is_file()}
    if artifacts != after:
        raise RuntimeError("model artifacts changed during comparison")
    (output / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
