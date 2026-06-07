#!/usr/bin/env python3
"""
Quick function-level scorer for mimirs rankings on SweRank data.

Computes Acc@k (a gold function in the top-k) + MRR over the instances actually
ranked — NOT diluted across the full HF dataset like the leaderboard script. Lets
us compare a small mimirs sample directly to SweRank's published function-level
baselines (Table 1):

    BM25            Acc@5 31.75  Acc@10 36.86
    CodeRankEmbed   Acc@5 51.82  Acc@10 58.76
    SweRankEmbed-S  Acc@5 63.14  Acc@10 74.45

Run:
    python swerank_score.py <topdocs.json> <datasets_dir> [dirPrefix]
"""
import glob
import json
import os
import sys

KS = [1, 3, 5, 10]


def load_qrels(datasets_dir, prefix):
    """instance_id -> set(gold corpus_ids), by scanning each instance's qrels."""
    gold = {}
    for d in glob.glob(os.path.join(datasets_dir, prefix + "*")):
        tsv = os.path.join(d, "qrels", "test.tsv")
        if not os.path.exists(tsv):
            continue
        for line in open(tsv):
            parts = line.rstrip("\n").split("\t")
            if len(parts) != 3 or parts[0] in ("", "query-id"):
                continue
            qid, cid, _ = parts
            gold.setdefault(qid, set()).add(cid)
    return gold


def main():
    topdocs = json.load(open(sys.argv[1]))
    datasets_dir = sys.argv[2]
    prefix = sys.argv[3] if len(sys.argv) > 3 else "swe-bench-lite-function_"
    gold = load_qrels(datasets_dir, prefix)

    n, acc, mrr = 0, {k: 0.0 for k in KS}, 0.0
    for qid, ranked in topdocs.items():
        g = gold.get(qid)
        if not g:
            continue
        n += 1
        for k in KS:
            if g & set(ranked[:k]):
                acc[k] += 1
        for i, doc in enumerate(ranked):
            if doc in g:
                mrr += 1.0 / (i + 1)
                break

    if n == 0:
        print("No scored instances (check dirPrefix vs topdocs ids).")
        return
    print(f"{n} instances scored")
    print("  " + "  ".join(f"Acc@{k} {100*acc[k]/n:5.2f}" for k in KS) + f"  MRR {mrr/n:.3f}")


if __name__ == "__main__":
    main()
