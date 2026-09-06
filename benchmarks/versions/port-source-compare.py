#!/usr/bin/env python3
"""Compare extracted Rust windows and non-gap trees with a retained TS index.

No inference, source mutation, or benchmark query changes. Input is the report
from the ignored Rust source_stage_report probe and the original TS database.
"""
import argparse
import hashlib
import json
import sqlite3
from pathlib import Path


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def compare(report, database):
    db = sqlite3.connect(f"file:{database.resolve()}?mode=ro", uri=True)
    failures = []
    count = 0
    chunks = 0
    for file in report["files"]:
        path = file["path"]
        rows = db.execute("SELECT c.id,c.kind,c.name,c.start_offset,c.end_offset,c.parent_id "
                          "FROM source_chunks c JOIN files f ON f.id=c.file_id WHERE f.path=? ORDER BY c.id", (path,)).fetchall()
        ids = {row[0]: i for i, row in enumerate(rows)}
        tree = [[k, n, s, e, ids.get(p)] for _, k, n, s, e, p in rows]
        chunks += len(tree)
        if file["treeHash"] != digest(tree):
            failures.append({"path": path, "stage": "source tree", "rustCount": file["chunkCount"], "tsCount": len(tree)})
        windows = db.execute("SELECT w.start_offset,w.end_offset,w.start_line,w.end_line,w.text,c.kind,c.name,c.start_offset,c.end_offset "
                             "FROM source_windows w JOIN source_chunks c ON c.id=w.source_chunk_id JOIN files f ON f.id=c.file_id "
                             "WHERE f.path=? ORDER BY c.id,w.ordinal", (path,)).fetchall()
        expected = [{"startOffset": s, "endOffset": e, "startLine": sl, "endLine": el,
                     "textHash": hashlib.sha256(t.encode()).hexdigest(),
                     "sourceChunk": {"kind": k, "name": n, "startOffset": cs, "endOffset": ce}}
                    for s, e, sl, el, t, k, n, cs, ce in windows]
        count += len(windows)
        if expected != file["windows"]:
            failures.append({"path": path, "stage": "source windows", "rustCount": len(file["windows"]), "tsCount": len(windows)})
    indexed = {row[0] for row in db.execute("SELECT path FROM files")}
    actual = {file["path"] for file in report["files"]}
    if indexed != actual:
        failures.append({"stage": "file set", "missing": sorted(indexed - actual), "extra": sorted(actual - indexed)})
    return {"files": len(actual), "chunks": chunks, "windows": count, "mismatches": failures,
            "rustReportSha256": digest(report), "reference": "122674c8bfbbc3549390743f51396c5f0e4e3537"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path)
    parser.add_argument("database", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    result = compare(json.loads(args.report.read_text()), args.database)
    with args.output.open("x") as file:
        json.dump(result, file, indent=2)
        file.write("\n")
    print(json.dumps(result, indent=2))
    raise SystemExit(bool(result["mismatches"]))
