#!/usr/bin/env python3
"""Run every combination of the ranking plan's probes and report them.

Usage:
  python3 benchmarks/probes.py run --index NAME [--minutes M]
  python3 benchmarks/probes.py report --index NAME --output FILE [--formats NAME ...]

`run` copies each corpus's saved index .mimirs/index-NAME.db into place, then
runs the queries once per probe combination, solo probes first. A combination
that already has a result file is skipped, so a stopped run continues where it
left off. `--minutes` stops starting new combinations after that long.

`report` reads the result files of this commit and index and writes a Markdown
report. `--formats` adds a table comparing those saved indexes without probes.

The ranking plan's last slice deletes this script.
"""

import argparse
import datetime
import itertools
import json
import os
import shutil
import subprocess
import sys
import time

import run

# Probes that are on or off, in the order names are joined.
ON_OFF_PROBES = ["doc-references", "vector-weight", "unique-symbol", "second-chunk", "tests-lower"]
# The exact-name probe is off or one of these variants.
EXACT_NAME_VARIANTS = ["exact-name-own", "exact-name-full", "exact-name-long"]
NAME_ORDER = ["doc-references", "vector-weight", "unique-symbol", *EXACT_NAME_VARIANTS, "second-chunk", "tests-lower"]
CORPORA = ["mimirs-legacy", "excalidraw", "django", "kubernetes"]

# v2's final ranking, as the Rust port reproduced it
# (~/repos/mimirs/benchmarks/versions/port/kubernetes/FOUR-CORPUS.md).
V2_TARGET = {
    "mimirs-legacy": {"recall@5": 0.9797, "recall@10": 1.0, "recall@20": 1.0, "mrr": 0.8953},
    "excalidraw": {"recall@5": 0.9722, "recall@10": 1.0, "recall@20": 1.0, "mrr": 0.8299},
    "django": {"recall@5": 1.0, "recall@10": 1.0, "recall@20": 1.0, "mrr": 0.9098},
    "kubernetes": {"recall@5": 0.8667, "recall@10": 0.9417, "recall@20": 0.9667, "mrr": 0.7327},
}

MARKERS = ["¹", "²", "³"]
MOVES_LISTED = 5


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)
    run_command = commands.add_parser("run", help="run every combination")
    run_command.add_argument("--index", required=True, help="the saved index to query")
    run_command.add_argument("--minutes", type=float, help="stop starting combinations after this long")
    report_command = commands.add_parser("report", help="write the report")
    report_command.add_argument("--index", required=True, help="the saved index the combinations ran on")
    report_command.add_argument("--output", required=True, help="the Markdown file to write")
    report_command.add_argument("--formats", nargs="*", default=[], help="saved indexes to compare without probes")
    arguments = parser.parse_args()
    if arguments.command == "run":
        run_combinations(arguments.index, arguments.minutes)
    else:
        write_report(arguments.index, arguments.output, arguments.formats)


def combinations():
    """Every probe set, the empty one first, then by size."""
    sets = []
    for count in range(len(ON_OFF_PROBES) + 1):
        for on_off in itertools.combinations(ON_OFF_PROBES, count):
            for exact_name in [None, *EXACT_NAME_VARIANTS]:
                probes = list(on_off) + ([exact_name] if exact_name else [])
                sets.append(sorted(probes, key=NAME_ORDER.index))
    sets.sort(key=len)
    return sets


def result_name(commit, index, probes):
    """run.py's naming, without the date: `abc123-path-terms-tests-lower`."""
    return run.run_name({"mimirs_commit": commit, "index": index, "probes": ",".join(probes)})


def find_result(commit, index, probes):
    """The newest result file of this run, or None."""
    matches = sorted(run.RESULTS.glob(f"*-{result_name(commit, index, probes)}.json"))
    # The date is the name's first 10 characters; anything else means a longer
    # probe list that happens to share this prefix.
    exact = [path for path in matches if path.name[11:] == f"{result_name(commit, index, probes)}.json"]
    return exact[-1] if exact else None


def run_combinations(index, minutes):
    query_sets = run.find_query_sets([])
    for corpus, commit, _ in query_sets:
        run.check_corpus(corpus, commit, will_index=True)
        if not run.saved_index(corpus, index).exists():
            sys.exit(f"{run.saved_index(corpus, index)} does not exist")
    subprocess.run(["cargo", "build", "--release", "--quiet"], cwd=run.REPO, check=True)
    commit = run.mimirs_commit()
    for corpus, _, _ in query_sets:
        folder = run.CORPORA / corpus
        run.delete_index(folder)
        shutil.copyfile(run.saved_index(corpus, index), folder / ".mimirs" / "index.db")

    started = time.monotonic()
    pending = [probes for probes in combinations() if find_result(commit, index, probes) is None]
    print(f"{len(pending)} of {len(combinations())} combinations to run", flush=True)
    for number, probes in enumerate(pending, start=1):
        if minutes is not None and time.monotonic() - started > minutes * 60:
            print(f"Stopped after {minutes} minutes; run again to continue", flush=True)
            return
        print(f"[{number}/{len(pending)}] {','.join(probes) or 'no probes'}", flush=True)
        os.environ["MIMIRS_PROBES"] = ",".join(probes)
        results = {
            "date": datetime.datetime.now().isoformat(timespec="seconds"),
            "mimirs_commit": commit,
            "index": index,
            "probes": ",".join(probes),
            "corpora": {},
        }
        for corpus, corpus_commit, path in query_sets:
            queries = json.loads(path.read_text())
            corpus_started = time.monotonic()
            ranked = run.rank_queries(corpus, run.CORPORA / corpus, queries)
            results["corpora"][corpus] = {
                "commit": corpus_commit,
                "queries": ranked,
                "query_seconds": round(time.monotonic() - corpus_started, 1),
                "metrics": run.metrics(ranked),
            }
        date = datetime.date.today().isoformat()
        output = run.RESULTS / f"{date}-{run.run_name(results)}.json"
        output.write_text(json.dumps(results, indent=2) + "\n")
    print("Every combination has a result", flush=True)


def first_hit(query):
    """The rank of the query's first expected file, or None when none is listed."""
    ranks = [rank for rank in query["ranks"].values() if rank is not None]
    return min(ranks) if ranks else None


def moves(baseline_queries, queries):
    """(better, same, worse) first-hit counts, and every changed query as
    (query, old rank, new rank), where None means not listed."""
    better = same = worse = 0
    changed = []
    for old, new in zip(baseline_queries, queries):
        old_rank, new_rank = first_hit(old), first_hit(new)
        old_key = old_rank or run.MAP_FILES + 1
        new_key = new_rank or run.MAP_FILES + 1
        if new_key < old_key:
            better += 1
        elif new_key > old_key:
            worse += 1
        else:
            same += 1
        if new_key != old_key:
            changed.append((old["query"], old_rank, new_rank, old_key - new_key))
    return better, same, worse, changed


def corpus_queries(result, corpus):
    return result["corpora"][corpus]["queries"] if corpus in result["corpora"] else None


def all_queries(result):
    return [query for corpus in CORPORA for query in result["corpora"].get(corpus, {}).get("queries", [])]


def weighted_v2():
    counts = {"mimirs-legacy": 74, "excalidraw": 72, "django": 116, "kubernetes": 120}
    total = sum(counts.values())
    return {
        metric: sum(V2_TARGET[corpus][metric] * counts[corpus] for corpus in CORPORA) / total
        for metric in ["recall@5", "recall@10", "recall@20", "mrr"]
    }


def table_rows(results, baseline, corpus):
    """One row of numbers per result: label, then metrics and moves."""
    rows = []
    for label, result in results:
        if corpus is None:
            queries, base = all_queries(result), all_queries(baseline)
        else:
            queries, base = corpus_queries(result, corpus), corpus_queries(baseline, corpus)
        metric = run.metrics(queries)
        better, same, worse, _ = moves(base, queries)
        rows.append({
            "label": label,
            "R@5": metric["recall@5"] * 100,
            "R@10": metric["recall@10"] * 100,
            "R@20": metric["recall@20"] * 100,
            "MRR": metric["mrr"],
            "zero-miss": metric["zero_miss"] * 100,
            "better": better,
            "same": same,
            "worse": worse,
        })
    return rows


# Columns, their format, and whether higher is better (None: no marker).
COLUMNS = [
    ("R@5", "{:.1f}%", True),
    ("R@10", "{:.1f}%", True),
    ("R@20", "{:.1f}%", True),
    ("MRR", "{:.3f}", True),
    ("zero-miss", "{:.1f}%", False),
    ("better", "{}", True),
    ("same", "{}", None),
    ("worse", "{}", False),
]


def markdown_table(rows, target):
    """Rows sorted by MRR, the 3 best values of each column marked, and the
    v2 target last."""
    rows = sorted(rows, key=lambda row: (-row["MRR"], row["label"]))
    best_values = {}
    for name, number_format, higher_is_better in COLUMNS:
        if higher_is_better is None:
            continue
        distinct = sorted({round(row[name], 6) for row in rows}, reverse=higher_is_better)
        best_values[name] = distinct[:len(MARKERS)]
    header = ["Probes"] + [name for name, _, _ in COLUMNS]
    lines = ["| " + " | ".join(header) + " |", "|---" + "|---:" * len(COLUMNS) + "|"]
    for row in rows:
        cells = [row["label"]]
        for name, number_format, higher_is_better in COLUMNS:
            cell = number_format.format(row[name])
            if name in best_values and round(row[name], 6) in best_values[name]:
                cell += MARKERS[best_values[name].index(round(row[name], 6))]
            cells.append(cell)
        lines.append("| " + " | ".join(cells) + " |")
    target_cells = ["v2 target"]
    for name, number_format, _ in COLUMNS:
        key = {"R@5": "recall@5", "R@10": "recall@10", "R@20": "recall@20", "MRR": "mrr"}.get(name)
        if key is None:
            target_cells.append("—")
        elif name == "MRR":
            target_cells.append(f"{target[key]:.3f}")
        else:
            target_cells.append(f"{target[key] * 100:.1f}%")
    lines.append("| " + " | ".join(target_cells) + " |")
    return "\n".join(lines)


def describe_rank(rank):
    return "not listed" if rank is None else str(rank)


def write_report(index, output_path, formats):
    commit = run.mimirs_commit()
    baseline_path = find_result(commit, index, [])
    if baseline_path is None:
        sys.exit(f"No result without probes for {commit} on index {index}")
    baseline = json.loads(baseline_path.read_text())
    results = []
    missing = []
    for probes in combinations():
        path = find_result(commit, index, probes)
        if path is None:
            missing.append(probes)
            continue
        results.append((", ".join(probes) or "no probes", json.loads(path.read_text())))

    lines = [
        f"# Ranking probes on index `{index}`",
        "",
        f"Commit `{commit}`; {len(results)} of {len(combinations())} combinations measured. "
        "Moves compare each query's first expected file with the run without probes "
        "(better / same / worse). Markers `¹ ² ³` show the 3 best values in a column; "
        "for zero-miss and worse, lowest is best. The v2 target is not a controlled "
        "comparison (see the plan's S10).",
        "",
    ]
    if 0 < len(missing) <= 10:
        lines += ["Not measured: " + "; ".join(", ".join(probes) for probes in missing), ""]
    elif missing:
        lines += [f"Not measured: {len(missing)} combinations.", ""]

    if formats:
        format_results = []
        for name in formats:
            path = find_format_result(name)
            if path is None:
                lines += [f"No run without probes for index `{name}`.", ""]
                continue
            format_results.append((name, json.loads(path.read_text())))
        if format_results:
            format_baseline = dict(format_results).get("none", format_results[0][1])
            lines += ["## Path formats (S3), no probes", "", "Moves compare with the index without a prefix.", ""]
            lines += [markdown_table(table_rows(format_results, format_baseline, None), weighted_v2()), ""]
            for corpus in CORPORA:
                lines += [f"### {corpus}", ""]
                lines += [markdown_table(table_rows(format_results, format_baseline, corpus), V2_TARGET[corpus]), ""]

    solo = [(label, result) for label, result in results if label.count(",") == 0]
    lines += ["## Each probe alone", ""]
    lines += [markdown_table(table_rows(solo, baseline, None), weighted_v2()), ""]

    lines += ["## Weighted, all combinations", ""]
    lines += [markdown_table(table_rows(results, baseline, None), weighted_v2()), ""]
    for corpus in CORPORA:
        lines += [f"## {corpus}, all combinations", ""]
        lines += [markdown_table(table_rows(results, baseline, corpus), V2_TARGET[corpus]), ""]

    lines += ["## Largest moves", "", f"The {MOVES_LISTED} largest first-hit moves each way, all corpora.", ""]
    for label, result in results:
        if label == "no probes":
            continue
        _, _, _, changed = moves(all_queries(baseline), all_queries(result))
        if not changed:
            continue
        changed.sort(key=lambda move: -move[3])
        gains = [move for move in changed if move[3] > 0][:MOVES_LISTED]
        losses = [move for move in reversed(changed) if move[3] < 0][:MOVES_LISTED]
        lines += [f"### {label}", ""]
        for query, old_rank, new_rank, _ in gains + losses:
            lines.append(f"- {describe_rank(old_rank)} → {describe_rank(new_rank)}: {query}")
        lines.append("")

    with open(output_path, "w") as output:
        output.write("\n".join(lines))
    print(f"Wrote {output_path}")


def find_format_result(name):
    """The newest run on saved index `name` without ranking probes, at any
    commit. A format's own run has its path probe turned on, which only
    changes indexing."""
    newest = None
    for path in sorted(run.RESULTS.glob("*.json"), key=lambda path: path.stat().st_mtime):
        result = json.loads(path.read_text())
        probes = [probe for probe in result.get("probes", "").split(",") if probe]
        if result.get("index") == name and all(probe.startswith("path-") for probe in probes):
            newest = path
    return newest


if __name__ == "__main__":
    main()
