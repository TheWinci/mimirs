#!/usr/bin/env python3
"""Check a final binary against retained adoption indexes and CLI responses."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess

HERE = Path(__file__).resolve().parent

if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--root", type=Path, required=True)
    p.add_argument("--binary", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    args = p.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    binary = args.binary.resolve()
    result = {"binarySha256": hashlib.sha256(binary.read_bytes()).hexdigest(), "corpora": {}}
    for corpus in ("mimirs", "excalidraw", "django"):
        project = args.root.resolve() / "projects" / f"{corpus}-rust-0"
        profile = args.output.resolve() / f"{corpus}-unchanged.json"
        run = subprocess.run([str(binary), "index", "--profile", str(profile)], cwd=project, capture_output=True, check=True)
        counters = json.loads(profile.read_text())["counters"]
        assert counters.get("embedding_calls", 0) == 0, "unchanged index embedded source"
        assert counters.get("files_indexed", 0) == 0
        queries = json.loads((HERE / "queries" / f"{corpus}.json").read_text())
        for i, query in enumerate(queries):
            actual = subprocess.check_output([str(binary), "search", query["query"], "--limit", "20"], cwd=project, text=True)
            expected = (args.root / "results" / corpus / "rust/search" / f"0-{i}.stdout").read_text()
            normalize = lambda text: re.sub(r"(?m)^time: [^\n]+$", "time: ignored", text, count=1)
            if normalize(actual) != normalize(expected):
                (args.output / f"{corpus}-{i}-actual.txt").write_text(actual)
                raise ValueError(f"final CLI response changed: {corpus} query {i}")
        result["corpora"][corpus] = {"queries": len(queries), "responseMismatches": 0,
                                     "filesReused": counters["files_reused"], "embeddingCalls": 0}
        print(corpus, result["corpora"][corpus], flush=True)
    (args.output / "final-check.json").write_text(json.dumps(result, indent=2) + "\n")
