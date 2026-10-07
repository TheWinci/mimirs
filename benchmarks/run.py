#!/usr/bin/env python3
"""Measure `mimirs context` on v1's query sets.

Usage: python3 benchmarks/run.py [--index | --fresh-index NAME | --use-index NAME] [corpus ...]

MIMIRS_PROBES is passed through to `mimirs`, and the result file is named
after the index and probes so runs do not overwrite each other.

Each corpus is a local clone in ~/repos/benchmarks/mimirs/<corpus>, set up once
by hand with its .mimirs/config.toml. Its queries are in
benchmarks/queries/<corpus>@<commit>.json, and the clone must be at that commit.
"""

import argparse
import datetime
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
QUERY_SETS = REPO / "benchmarks" / "queries"
CORPORA = Path.home() / "repos" / "benchmarks" / "mimirs"
RESULTS = CORPORA / "results"
BINARY = REPO / "target" / "release" / "mimirs"

# Ranks are read this deep; a file further down counts as not found.
MAP_FILES = 100
RECALL_DEPTHS = [5, 10, 20]
# A query misses when none of its files is in this many results (v1's zero-miss).
MISS_DEPTH = 10

# A map line: "  3. src/search/hybrid.ts:392  const merged = ..."
MAP_LINE = re.compile(r"^\s*\d+\. (.+?):\d+  ")


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    indexing = parser.add_mutually_exclusive_group()
    indexing.add_argument("--index", action="store_true", help="run `mimirs index` first")
    indexing.add_argument(
        "--fresh-index",
        metavar="NAME",
        help="delete the index, build it from scratch, and save a copy as .mimirs/index-NAME.db",
    )
    indexing.add_argument(
        "--use-index",
        metavar="NAME",
        help="copy .mimirs/index-NAME.db back before the queries",
    )
    parser.add_argument("corpora", nargs="*", help="corpus names; all when omitted")
    arguments = parser.parse_args()
    will_index = arguments.index or arguments.fresh_index is not None

    query_sets = find_query_sets(arguments.corpora)
    for corpus, commit, _ in query_sets:
        check_corpus(corpus, commit, will_index)
        if arguments.use_index and not saved_index(corpus, arguments.use_index).exists():
            sys.exit(f"{saved_index(corpus, arguments.use_index)} does not exist")
    subprocess.run(["cargo", "build", "--release", "--quiet"], cwd=REPO, check=True)

    results = {
        "date": datetime.datetime.now().isoformat(timespec="seconds"),
        "mimirs_commit": mimirs_commit(),
        "index": arguments.fresh_index or arguments.use_index,
        "probes": os.environ.get("MIMIRS_PROBES", ""),
        "corpora": {},
    }
    for corpus, commit, path in query_sets:
        folder = CORPORA / corpus
        result = {"commit": commit}
        if arguments.fresh_index:
            delete_index(folder)
        if will_index:
            result["index_seconds"] = index(corpus, folder)
        if arguments.fresh_index:
            shutil.copyfile(folder / ".mimirs" / "index.db", saved_index(corpus, arguments.fresh_index))
        if arguments.use_index:
            delete_index(folder)
            shutil.copyfile(saved_index(corpus, arguments.use_index), folder / ".mimirs" / "index.db")
        queries = json.loads(path.read_text())
        started = time.monotonic()
        result["queries"] = rank_queries(corpus, folder, queries)
        result["query_seconds"] = round(time.monotonic() - started, 1)
        result["metrics"] = metrics(result["queries"])
        results["corpora"][corpus] = result

    print_report(results)
    RESULTS.mkdir(parents=True, exist_ok=True)
    date = datetime.date.today().isoformat()
    output = RESULTS / f"{date}-{run_name(results)}.json"
    output.write_text(json.dumps(results, indent=2) + "\n")
    print(f"\nSaved {output}")


def run_name(results):
    """The commit, then the index and probes when set: `abc123-path-terms-exact-name-own`."""
    parts = [results["mimirs_commit"]]
    if results["index"]:
        parts.append(results["index"])
    if results["probes"]:
        parts.append(results["probes"].replace(",", "+"))
    return "-".join(parts)


def saved_index(corpus, name):
    return CORPORA / corpus / ".mimirs" / f"index-{name}.db"


def delete_index(folder):
    """Remove the index and its write-ahead files, so the next build starts empty."""
    for suffix in ["", "-wal", "-shm"]:
        (folder / ".mimirs" / f"index.db{suffix}").unlink(missing_ok=True)


def find_query_sets(names):
    """(corpus, commit, path) for each query set, limited to `names` when given."""
    query_sets = []
    for path in sorted(QUERY_SETS.glob("*@*.json")):
        corpus, commit = path.stem.split("@")
        if not names or corpus in names:
            query_sets.append((corpus, commit, path))
    found = {corpus for corpus, _, _ in query_sets}
    unknown = [name for name in names if name not in found]
    if unknown:
        sys.exit(f"No query set for {', '.join(unknown)} in {QUERY_SETS}")
    return query_sets


def check_corpus(corpus, commit, will_index):
    """Stop unless the clone exists at the query set's commit and can be queried."""
    folder = CORPORA / corpus
    if not (folder / ".mimirs" / "config.toml").exists():
        sys.exit(f"{folder} is not set up; clone it and write .mimirs/config.toml first")
    head = git(folder, "rev-parse", "HEAD")
    expected = git(folder, "rev-parse", f"{commit}^{{commit}}")
    if head != expected:
        sys.exit(f"{folder} is at {head[:11]}, but its queries were written for {commit}")
    if not will_index and not (folder / ".mimirs" / "index.db").exists():
        sys.exit(f"{folder} has no index; run with --index")


def git(folder, *arguments):
    output = subprocess.run(["git", *arguments], cwd=folder, capture_output=True, text=True, check=True)
    return output.stdout.strip()


def mimirs_commit():
    """The short commit of this repo, marked when the working tree has changes."""
    commit = git(REPO, "rev-parse", "--short", "HEAD")
    if git(REPO, "status", "--porcelain", "--untracked-files=no"):
        commit += "-dirty"
    return commit


def index(corpus, folder):
    print(f"Indexing {corpus} ...", flush=True)
    started = time.monotonic()
    subprocess.run([BINARY, "index"], cwd=folder, check=True)
    seconds = round(time.monotonic() - started, 1)
    print(f"Indexed {corpus} in {seconds} s\n", flush=True)
    return seconds


def rank_queries(corpus, folder, queries):
    """Each query with the rank of every expected file, or None when not listed."""
    ranked = []
    for number, query in enumerate(queries, start=1):
        print(f"\r{corpus}: query {number}/{len(queries)}", end="", flush=True)
        files = map_files(folder, query["query"])
        ranks = {}
        for path in query["expected"]:
            ranks[path] = files.index(path) + 1 if path in files else None
        ranked.append({"query": query["query"], "ranks": ranks})
    print()
    return ranked


def map_files(folder, query):
    """The paths in `context`'s file map, best first."""
    output = subprocess.run(
        [BINARY, "context", query, "--files", str(MAP_FILES), "--budget", "0"],
        cwd=folder,
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    # Ranks count source files only; docs have their own list after the map.
    after_heading = output.split("Relevant files\n", 1)[1]
    map_section = after_heading.split("\nRelevant docs", 1)[0].split("\nExcerpts", 1)[0]
    files = []
    for line in map_section.splitlines():
        match = MAP_LINE.match(line)
        if match:
            files.append(match.group(1))
    return files


def metrics(queries):
    """v1's definitions: recall is the share of expected files within K,
    reciprocal rank is 1 / rank of the first expected file (0 when none)."""
    recall = {depth: 0.0 for depth in RECALL_DEPTHS}
    reciprocal_rank = 0.0
    misses = 0
    for query in queries:
        ranks = [rank for rank in query["ranks"].values() if rank is not None]
        for depth in RECALL_DEPTHS:
            found = sum(1 for rank in ranks if rank <= depth)
            recall[depth] += found / len(query["ranks"])
        if ranks:
            reciprocal_rank += 1 / min(ranks)
        if not any(rank <= MISS_DEPTH for rank in ranks):
            misses += 1
    count = len(queries)
    result = {"queries": count}
    for depth in RECALL_DEPTHS:
        result[f"recall@{depth}"] = recall[depth] / count
    result["mrr"] = reciprocal_rank / count
    result["zero_miss"] = misses / count
    return result


def print_report(results):
    print(f"\nmimirs {results['mimirs_commit']}, {results['date']}\n")
    header = ["corpus", "queries"] + [f"R@{depth}" for depth in RECALL_DEPTHS] + ["MRR", "zero-miss", "time"]
    rows = []
    for corpus, result in results["corpora"].items():
        rows.append(metric_row(corpus, result["metrics"], f"{result['query_seconds']} s"))
    if len(results["corpora"]) > 1:
        rows.append(metric_row("weighted", weighted_metrics(results), ""))
    print_table(header, rows)

    for corpus, result in results["corpora"].items():
        missed = [query for query in result["queries"] if not is_hit(query)]
        if not missed:
            continue
        print(f"\n{corpus}: {len(missed)} missed at {MISS_DEPTH}")
        for query in missed:
            ranks = ", ".join(f"{path} {rank or '-'}" for path, rank in query["ranks"].items())
            print(f"  {query['query']}\n    {ranks}")


def is_hit(query):
    return any(rank is not None and rank <= MISS_DEPTH for rank in query["ranks"].values())


def weighted_metrics(results):
    """Each metric averaged over corpora, weighted by their query counts."""
    all_metrics = [result["metrics"] for result in results["corpora"].values()]
    total = sum(metric["queries"] for metric in all_metrics)
    weighted = {"queries": total}
    for name in all_metrics[0]:
        if name != "queries":
            weighted[name] = sum(metric[name] * metric["queries"] for metric in all_metrics) / total
    return weighted


def metric_row(name, metric, time_taken):
    row = [name, str(metric["queries"])]
    row += [f"{metric[f'recall@{depth}'] * 100:.1f}%" for depth in RECALL_DEPTHS]
    row += [f"{metric['mrr']:.3f}", f"{metric['zero_miss'] * 100:.1f}%", time_taken]
    return row


def print_table(header, rows):
    widths = [max(len(row[column]) for row in [header] + rows) for column in range(len(header))]
    for row in [header] + rows:
        cells = [row[0].ljust(widths[0])] + [cell.rjust(width) for cell, width in zip(row[1:], widths[1:])]
        print("  ".join(cells))


if __name__ == "__main__":
    main()
