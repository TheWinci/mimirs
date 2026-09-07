#!/usr/bin/env python3
"""Collect the deferred Kubernetes checkpoint without repeating inference."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import statistics
import sqlite3

from audit import audit
from parity import check as cli_parity
from run import score

HERE = Path(__file__).resolve().parent


def load(path):
    return json.loads(path.read_text())


def module(name):
    spec = importlib.util.spec_from_file_location(name, HERE / f"{name}.py")
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def collect(root, source_report):
    baseline = module("port-baseline")
    source = module("port-source-compare")
    vectors = module("port-vectors")
    manifest = baseline.verify_manifest(root, "kubernetes")
    provenance = load(root / "provenance.json")
    require(digest(root / "engines/mimirs-rust") == provenance["rustBinarySha256"], "binary changed")
    language = load(HERE / "port/languages/verification.json")
    require(provenance["rustBinarySha256"] == language["cli"]["binarySha256"], "language checkpoint used another binary")
    reference = load(HERE / "port/reference.json")["reference"]
    require(provenance["tsRevision"] == reference["revision"], "wrong TS revision")
    for path, expected in reference["sourceHashes"].items():
        require(digest(root / "engines/v2" / path) == expected, f"TS source changed: {path}")
    queries = load(HERE / "queries/kubernetes.json")
    engines = {}
    for version in ("v2", "rust"):
        project = root / "projects" / f"kubernetes-{version}-0"
        baseline.verify_project(project, manifest)
        directory = root / "results/kubernetes" / version
        complete = load(directory / "complete.json")
        require(complete["manifest_sha256"] == manifest["manifest_sha256"], "run manifest changed")
        quality = load(directory / "quality.json")
        cases = load(directory / "rust-cases.json") if version == "rust" else load(directory / "warm.json")["cases"]
        require(quality == complete["quality"] == score(queries, cases, manifest["expected_path_corrections"], project), "raw results disagree with quality")
        require(len(complete["trials"]) == 1, "expected one descriptive trial")
        trial = complete["trials"][0]
        require(not trial["database"]["missing_files"] and not trial["database"]["extra_files"], "incomplete coverage")
        phases = {name: load(directory / "trial-0" / f"{name}.json") for name in ("fresh", "unchanged", "edited", "restore")}
        query_measurements = [load(path) for path in sorted((directory / "search").glob("*.json"))]
        require(len(query_measurements) == (120 if version == "rust" else 10), "missing query timings")
        query_seconds = sum(row["wall_seconds"] for row in query_measurements)
        warm = None
        if version == "v2":
            warm_process = load(directory / "warm-process.json")
            query_seconds += warm_process["wall_seconds"]
            warm_data = load(directory / "warm.json")
            warm = {"openMs": warm_data["openMs"], "firstSearchMs": warm_data["firstSearchMs"],
                    "queries": len(warm_data["cases"]), "searchSeconds": sum(row["ms"] for row in warm_data["cases"]) / 1000,
                    "process": warm_process}
        cli = load(directory / "cli.json")
        engines[version] = {"quality": quality, "phases": phases, "database": trial["database"],
                            "indexSummary": (directory / "trial-0/fresh.stdout").read_text(),
                            "editPaths": trial["edit_paths"], "queryProcessSeconds": query_seconds,
                            "measuredProcessTotalSeconds": sum(row["wall_seconds"] for row in phases.values()) + query_seconds,
                            "cliSamples": len(cli), "cliMedianSeconds": statistics.median(row["wall_seconds"] for row in cli),
                            "cliPeakRssBytes": max(row["peak_rss_bytes"] for row in cli), "warmApi": warm,
                            "artifactHashes": {name: digest(directory / name) for name in ("complete.json", "quality.json", "cli.json")}}
    parity = cli_parity(root, "kubernetes", "v2")
    require(len(parity) == 10 and all(row["matches"] for row in parity), "TS CLI/API mismatch")
    comparisons = []
    for rust, ts in zip(engines["rust"]["quality"]["cases"], engines["v2"]["quality"]["cases"], strict=True):
        require(rust["query"] == ts["query"] and rust["expected"] == ts["expected"], "different queries")
        comparisons.append({"index": rust["index"], "query": rust["query"], "expected": rust["expected"],
                            "rustPaths": rust["paths"], "tsPaths": ts["paths"], "matchesTs": rust["paths"] == ts["paths"],
                            "rustReciprocalRank": rust["rr"], "tsReciprocalRank": ts["rr"]})
    for engine in engines.values():
        engine["quality"] = {key: value for key, value in engine["quality"].items() if key != "cases"}
    rust_project = root / "projects/kubernetes-rust-0"
    ts_database = root / "projects/kubernetes-v2-0/.mimirs/index.sqlite"
    extracted = load(source_report)
    with sqlite3.connect(f"file:{ts_database}?mode=ro", uri=True) as db:
        ts_hashes = dict(db.execute("SELECT path,content_hash FROM files"))
    require(ts_hashes == {row["path"]: row["sourceHash"] for row in extracted["files"]}, "TS snapshots differ from extracted source")
    source_comparison = source.compare(extracted, ts_database)
    vector_comparison = vectors.compare(vectors.read(rust_project / ".mimirs/index.db", "rust"), vectors.read(ts_database, "v2"))
    evidence = audit(rust_project, load(root / "results/kubernetes/rust/rust-cases.json"))
    return {"provenance": provenance, "manifestSha256": manifest["manifest_sha256"], "querySha256": manifest["query_sha256"],
            "sourceProbeInput": extracted["baseline_db"],
            "engines": engines, "tsCliApiChecks": parity, "source": source_comparison, "vectors": vector_comparison,
            "evidence": evidence, "rankMismatches": sum(not row["matchesTs"] for row in comparisons), "cases": comparisons,
            "originalRust": None,
            "runnerWall": load(root / "runner-wall.json") if (root / "runner-wall.json").exists() else None,
            "timingScope": "One sequential trial per engine, TS then Rust, cached model assets and fresh indexes. A source-only Rust extraction check ran during TS indexing. Descriptive timings, not isolated performance measurements. Totals sum measured subprocesses and exclude copying, runner overhead and correctness audits. TS queries use 120 warm API calls plus warmup and 10 cold CLI samples; Rust uses 120 cold CLI calls. These totals are different workloads, not a speedup comparison."}


def markdown(report):
    lines = ["# Kubernetes retrieval checkpoint", "", "Rust and TS v2 return identical top-20 file rankings for all 120 original queries.", "",
             "| Engine | MRR@20 | R@5 | R@10 | R@20 | Fresh s | Unchanged s | Edited s | Restore s |", "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"]
    for name, engine in report["engines"].items():
        q, p = engine["quality"], engine["phases"]
        lines.append(f"| {name} | {q['mrr@20']:.4f} | {q['recall@5']:.4f} | {q['recall@10']:.4f} | {q['recall@20']:.4f} | {p['fresh']['wall_seconds']:.2f} | {p['unchanged']['wall_seconds']:.2f} | {p['edited']['wall_seconds']:.2f} | {p['restore']['wall_seconds']:.2f} |")
    lines += ["", "| Engine | Query processes s | Measured total s | Index MiB | Fresh peak MiB | Cold CLI median s |", "| --- | ---: | ---: | ---: | ---: | ---: | ---: |"]
    for name, e in report["engines"].items():
        lines.append(f"| {name} | {e['queryProcessSeconds']:.2f} | {e['measuredProcessTotalSeconds']:.2f} | {e['database']['index_bytes']/2**20:.1f} | {e['phases']['fresh']['peak_rss_bytes']/2**20:.1f} | {e['cliMedianSeconds']:.3f} |")
    s, v, p = report["source"], report["vectors"], report["provenance"]
    lines += ["", report["timingScope"], "",
              f"The pinned corpus has {s['files']:,} Go files. All {s['chunks']:,} non-gap source chunks and {s['windows']:,} windows match TS. All {v['vectors']:,} persisted vectors pass the frozen tolerance. Maximum component error is {v['maximumComponentError']:.3g}; minimum cosine is {v['minimumCosine']:.12f}. Ten TS CLI samples match its API. Every Rust stored input and displayed source span passes the exact-source audit.", "",
              f"Host: {p['cpu']}, {p['logicalCpus']} logical CPUs, {p['memoryBytes']/2**30:.0f} GiB memory, {p['host']}. Both engines use three inference threads in total. The JSON records the binary hash, revisions, unchanged corpus/query hashes, all rankings, phase CPU times, index coverage, and evidence counts.", "",
              "TS v2 also embeds fact and relation documents during indexing. Its default search retrieves these perspectives without fusing them into source rankings. Rust ports the source-ranking path; its index has a different workload and representation. Timing and index-size differences therefore do not isolate implementation language.", "",
              "The 11-minute target remains a performance follow-up. The reported friend's result has no verified matching workload or machine. The pre-port q8 Rust Kubernetes baseline was not run. File-label recall does not score answer correctness.", "",
              "Run `run.py --root ROOT --corpora kubernetes --versions v2 rust --repeats 1 --rust-limit 20` after the three development corpora and language checks. Extract the saved Rust snapshots using the ignored `source_stage_report` probe, then collect with `port-kubernetes.py --root ROOT --source-report SOURCE_JSON --output NEW_DIRECTORY`. Collection performs no inference.", ""]
    if report["runnerWall"]:
        lines += [f"Observed wall time for the whole two-engine runner, including source copies and runner overhead: {report['runnerWall']['wallSeconds']:.0f} seconds, measured within two seconds. This is separate from the per-engine subprocess totals above.", ""]
    return "\n".join(lines)


def four_corpus_markdown(report):
    adoption = load(HERE / "port/adoption/adoption.json")
    language = load(HERE / "port/languages/verification.json")
    lines = ["# Four-corpus retrieval verification", "",
             "The completed Rust retrieval port and language expansion reproduce TS v2's top-20 file rankings on all 382 original queries. No queries or corpus files were removed from the frozen suite.", "",
             "| Corpus | Queries | Rank mismatches | MRR@20 | R@5 | R@10 | R@20 | Pre-port q8 Rust MRR |",
             "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"]
    for name, row in adoption["corpora"].items():
        check = language["cli"]["corpora"][name]
        require(check["responseMismatches"] == check["embeddingCalls"] == 0, "development CLI regression")
        require(row["rankMismatches"] == row["vectors"]["failedVectors"] == 0, "development adoption mismatch")
        q = row["rust"]
        require(check["queries"] == q["queries"], "development query coverage changed")
        lines.append(f"| {name} | {q['queries']} | 0 | {q['mrr@20']:.4f} | {q['recall@5']:.4f} | {q['recall@10']:.4f} | {q['recall@20']:.4f} | {row['originalRust']['mrr@20']:.4f} |")
    q = report["engines"]["rust"]["quality"]
    lines.append(f"| kubernetes | {q['queries']} | {report['rankMismatches']} | {q['mrr@20']:.4f} | {q['recall@5']:.4f} | {q['recall@10']:.4f} | {q['recall@20']:.4f} | not run |")
    windows = sum(row["vectors"]["vectors"] for row in adoption["corpora"].values()) + report["vectors"]["vectors"]
    lines += ["", f"All {windows:,} persisted source-window vectors pass the frozen TS comparison tolerance. Source-tree/window comparisons and exact-source audits pass. File labels measure retrieval, not whether a displayed answer is correct.", "",
              "The [development adoption report](../adoption/ADOPTION.md) preserves the original three-corpus comparison and its per-query changes from pre-port q8 Rust. The [language checkpoint](../languages/README.md) verifies that the final release binary reproduces all 262 development CLI responses and retains the same analyses, documents, evidence and vectors. [Kubernetes](KUBERNETES.md) was run last with that same final binary; its JSON records all 120 ranking comparisons and measurements.", "",
              "Timing scopes remain separate. The earlier three-corpus costs belong to the adoption build. The final Kubernetes trial measures the completed language build, with cached model assets and a three-thread inference budget. It records fresh, unchanged, edited and restored indexing, query costs, whole-run time, memory and index size. Different TS/Rust indexing work and warm-API/cold-CLI query workloads prevent a language-only speedup claim.", "",
              "The implementation now includes 24 native languages, 26 grammars including dialects, Markdown sections and the remaining v1 formats through explicit text fallback. See [language support](../../../../docs/languages.md) for discovery rules, parser limits and reindexing instructions.", ""]
    return "\n".join(lines)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--source-report", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    require(not args.output.exists(), "output must be a new directory")
    report = collect(args.root.resolve(), args.source_report)
    failures = report["rankMismatches"] + len(report["source"]["mismatches"]) + report["vectors"]["failedVectors"]
    args.output.mkdir(parents=True)
    (args.output / "kubernetes.json").write_text(json.dumps(report, indent=2) + "\n")
    if not failures:
        (args.output / "KUBERNETES.md").write_text(markdown(report))
        (args.output / "FOUR-CORPUS.md").write_text(four_corpus_markdown(report))
    print(json.dumps({"rankMismatches": report["rankMismatches"], "sourceMismatches": len(report["source"]["mismatches"]), "vectorFailures": report["vectors"]["failedVectors"]}))
    raise SystemExit(bool(failures))
