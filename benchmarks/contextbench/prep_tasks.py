#!/usr/bin/env python3
"""
Dump ContextBench tasks (parquet -> JSONL) for the mimirs adapter.

The TS adapter can't read parquet, so this emits the columns it needs to clone +
query each instance. See plans/external-benchmarks-survey.md (ContextBench = GO).

Run (from a checkout of github.com/EuniAI/ContextBench, in its venv):
    python prep_tasks.py <contextbench_repo> <out_tasks.jsonl> [limit] [bench]

  bench = optional filter on `source` (Verified|Pro|Poly|Multi); default all.
"""
import json
import sys

import pandas as pd

PARQUET = "data/contextbench_verified.parquet"  # 500-instance verified split


def main():
    cb_repo = sys.argv[1].rstrip("/")
    out = sys.argv[2]
    limit = int(sys.argv[3]) if len(sys.argv) > 3 else 0
    bench = sys.argv[4] if len(sys.argv) > 4 else ""

    df = pd.read_parquet(f"{cb_repo}/{PARQUET}")
    if bench:
        df = df[df["source"].str.lower() == bench.lower()]
    if limit:
        df = df.head(limit)

    with open(out, "w") as f:
        for _, r in df.iterrows():
            f.write(json.dumps({
                "instance_id": r["instance_id"],
                "original_inst_id": r["original_inst_id"],
                "repo": r["repo"],          # "owner/name"
                "repo_url": r["repo_url"],
                "base_commit": r["base_commit"],
                "language": r["language"],
                "problem_statement": r["problem_statement"],
            }) + "\n")
    print(f"Wrote {len(df)} tasks -> {out}")


if __name__ == "__main__":
    main()
