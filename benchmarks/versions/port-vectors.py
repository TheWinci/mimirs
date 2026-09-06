#!/usr/bin/env python3
"""Compare every persisted source-window vector with a retained TS v2 index."""
import argparse
from collections import Counter
import hashlib
import json
import math
from pathlib import Path
import sqlite3
import struct


def read(path, engine):
    db = sqlite3.connect(f"file:{path.resolve()}?mode=ro", uri=True)
    table = "source_window_vectors" if engine == "v2" else "document_embeddings"
    vectors = {row: struct.unpack("<384f", data) for row, data in db.execute(
        f"SELECT r.rowid,substr(v.vectors,r.chunk_offset*1536+1,1536) "
        f"FROM {table}_rowids r JOIN {table}_vector_chunks00 v ON v.rowid=r.chunk_id")}
    if engine == "v2":
        rows = db.execute("SELECT f.path,w.id,w.text FROM source_windows w JOIN source_chunks c ON c.id=w.source_chunk_id "
                          "JOIN files f ON f.id=c.file_id ORDER BY f.path,c.id,w.ordinal")
    else:
        rows = db.execute("SELECT f.path,d.id,d.text FROM retrieval_documents d JOIN files f ON f.id=d.file_id ORDER BY f.path,d.ordinal")
    found = Counter()
    result = {}
    for path, row, text in rows:
        if engine == "rust":
            prefix = f"File: {path}\n"
            if not text.startswith(prefix):
                raise ValueError("incorrect path context")
            text = text[len(prefix):]
        key = (path, hashlib.sha256(text.encode()).hexdigest())
        ordinal = found[key]
        found[key] += 1
        result[(*key, ordinal)] = vectors[row]
    if len(result) != len(vectors):
        raise ValueError("orphan vectors")
    return result


def compare(rust, reference):
    if rust.keys() != reference.keys():
        raise ValueError("different source windows; compare extraction before vectors")
    worst = []
    maximum = 0.0
    minimum = 1.0
    failures = 0
    for key, a in rust.items():
        b = reference[key]
        error = max(abs(x-y) for x, y in zip(a, b))
        cosine = sum(x*y for x, y in zip(a, b)) / math.sqrt(sum(x*x for x in a)*sum(y*y for y in b))
        maximum = max(maximum, error)
        minimum = min(minimum, cosine)
        if error > 1e-5 or cosine < 0.999999:
            failures += 1
            worst.append({"path": key[0], "textHash": key[1], "occurrence": key[2], "error": error, "cosine": cosine})
    return {"vectors": len(rust), "maximumComponentError": maximum, "minimumCosine": minimum,
            "failedVectors": failures, "worst": sorted(worst, key=lambda x: -x["error"])[:20],
            "tolerance": {"component": 1e-5, "cosine": 0.999999}}


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("rust", type=Path)
    p.add_argument("reference", type=Path)
    p.add_argument("output", type=Path)
    args = p.parse_args()
    report = compare(read(args.rust, "rust"), read(args.reference, "v2"))
    with args.output.open("x") as file:
        json.dump(report, file, indent=2)
        file.write("\n")
    print(json.dumps(report, indent=2))
    raise SystemExit(bool(report["failedVectors"]))
