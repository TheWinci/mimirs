#!/usr/bin/env python3
"""Freeze the three-corpus adoption comparison without running new inference."""
import argparse
import importlib.util
import json
from pathlib import Path
import platform
import statistics
import subprocess

from audit import audit
from run import score

HERE = Path(__file__).resolve().parent

def load(path):
    return json.loads(path.read_text())

def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result

baseline = module("port_baseline", HERE / "port-baseline.py")
vectors = module("port_vectors", HERE / "port-vectors.py")


def collect(root, reference):
    original = load(HERE / "port/baseline/baseline.json")
    result = {"reference": baseline.TS, "originalRust": baseline.RUST,
              "provenance": load(root / "provenance.json"),
              "host": {"platform": platform.platform(), "cpu": subprocess.check_output(["sysctl", "-n", "machdep.cpu.brand_string"], text=True).strip(),
                       "logicalCpus": int(subprocess.check_output(["sysctl", "-n", "hw.logicalcpu"], text=True)),
                       "memoryBytes": int(subprocess.check_output(["sysctl", "-n", "hw.memsize"], text=True))},
              "budgets": {"semanticCandidates": 150, "lexicalCandidates": 100, "filesBeforeSegmentation": 100,
                          "sourceFilesReturned": 20, "documentationFiles": 5, "inferenceWorkers": 3, "threadsPerWorker": 1},
              "timingScope": "One development trial per corpus, cached model assets, fresh/unchanged/two-file-edit indexing and cold CLI queries. Some correctness checks ran concurrently. Descriptive costs, not isolated speedup claims.",
              "kubernetes": "deferred until language work is complete", "corpora": {}}
    for corpus in baseline.CORPORA:
        manifest = baseline.verify_manifest(root, corpus)
        project = root / "projects" / f"{corpus}-rust-0"
        baseline.verify_project(project, manifest)
        directory = root / "results" / corpus / "rust"
        complete = load(directory / "complete.json")
        quality = load(directory / "quality.json")
        cases = load(directory / "rust-cases.json")
        queries = load(HERE / "queries" / f"{corpus}.json")
        assert complete["manifest_sha256"] == manifest["manifest_sha256"]
        assert quality == complete["quality"] == score(queries, cases, manifest["expected_path_corrections"], project)
        ts = load(reference / "results" / corpus / "v2/quality.json")
        assert ts == load(HERE / "results" / f"{corpus}-v2-quality.json")
        old = next(p for p in original["pairs"] if p["corpus"] == corpus and p["version"] == "rust")
        old_quality = old["quality"]
        differences = []
        for actual, expected, previous in zip(quality["cases"], ts["cases"], old_quality["cases"], strict=True):
            assert actual["query"] == expected["query"] == previous["query"]
            differences.append({"index": actual["index"], "query": actual["query"], "expected": actual["expected"],
                                "paths": actual["paths"], "tsPaths": expected["paths"], "originalRustPaths": previous["paths"],
                                "matchesTs": actual["paths"] == expected["paths"],
                                "reciprocalRankChange": actual["rr"] - previous["rr"],
                                "recall5Change": actual["recall@5"] - previous["recall@5"]})
        vector_report = vectors.compare(vectors.read(project / ".mimirs/index.db", "rust"),
                                        vectors.read(reference / "projects" / f"{corpus}-v2-0/.mimirs/index.sqlite", "v2"))
        evidence = audit(project, cases)
        metrics = lambda q: {k: v for k, v in q.items() if k != "cases"}
        cli = load(directory / "cli.json")
        trial = complete["trials"][0]
        result["corpora"][corpus] = {"manifestSha256": manifest["manifest_sha256"], "querySha256": manifest["query_sha256"],
            "rust": metrics(quality), "ts": metrics(ts), "originalRust": metrics(old_quality),
            "rankMismatches": sum(not d["matchesTs"] for d in differences), "vectors": vector_report, "evidence": evidence,
            "measurement": {"fresh": trial["fresh"], "unchanged": trial["unchanged"], "edited": trial["edited"],
                            "editPaths": trial["edit_paths"], "database": trial["database"],
                            "cliSamples": len(cli), "cliMedianSeconds": statistics.median(x["wall_seconds"] for x in cli),
                            "cliPeakRssBytes": max(x["peak_rss_bytes"] for x in cli)}, "cases": differences}
    return result


def markdown(report):
    lines = ["# Retrieval port adoption", "", "The Rust port reproduces TS v2's top 20 source files on the original three development corpora. Kubernetes is deferred.", "",
             "| Corpus | Queries | TS rank mismatches | R@5 | R@10 | R@20 | MRR@20 | Original Rust MRR |", "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"]
    for name, row in report["corpora"].items():
        q = row["rust"]
        lines.append(f"| {name} | {q['queries']} | {row['rankMismatches']} | {q['recall@5']:.4f} | {q['recall@10']:.4f} | {q['recall@20']:.4f} | {q['mrr@20']:.4f} | {row['originalRust']['mrr@20']:.4f} |")
    lines += ["", "All file rankings are compared per query in `adoption.json`. The source-tree, token-input, vector, and native ranking checks isolate the stages of the port. File labels do not establish answer correctness. Documentation segmentation and references use dedicated differential and exact-evidence fixtures.", "",
              "| Corpus | Fresh s | Unchanged s | Edited s | Index MiB | Index peak MiB | Cold CLI median s |", "| --- | ---: | ---: | ---: | ---: | ---: | ---: |"]
    for name, row in report["corpora"].items():
        m = row["measurement"]
        lines.append(f"| {name} | {m['fresh']['wall_seconds']:.2f} | {m['unchanged']['wall_seconds']:.2f} | {m['edited']['wall_seconds']:.2f} | {m['database']['index_bytes']/2**20:.1f} | {m['fresh']['peak_rss_bytes']/2**20:.1f} | {m['cliMedianSeconds']:.3f} |")
    lines += ["", report["timingScope"], "", "Each run uses three workers and one inference thread per worker. Query timings include process and model startup. The two edited files are the largest files named by fixed query labels; the runner restores them before scoring. The JSON records hardware, cache scope, binary provenance, edit paths, index size, source coverage, displayed evidence checks, and every vector comparison.", "",
              "Reproduce with `run.py --corpora mimirs excalidraw django --versions rust --repeats 1 --rust-limit 20` in a new root containing the port binary and original manifests. Collect without new inference using `port-adoption.py --root ROOT --reference-root TS_ROOT --output NEW_DIRECTORY`.", ""]
    lines += ["The final release binary is checked against every saved CLI response, excluding elapsed time, with `port-final-check.py`. It also verifies unchanged indexing performs zero embedding calls. See `final-check.json` for the recorded binary and counts.", ""]
    return "\n".join(lines)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--reference-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise ValueError("output must be a new directory")
    report = collect(args.root.resolve(), args.reference_root.resolve())
    failures = sum(r["rankMismatches"] + r["vectors"]["failedVectors"] for r in report["corpora"].values())
    args.output.mkdir(parents=True)
    (args.output / "adoption.json").write_text(json.dumps(report, indent=2) + "\n")
    if not failures:
        (args.output / "ADOPTION.md").write_text(markdown(report))
    print(json.dumps({name: {"rankMismatches": r["rankMismatches"], "vectorFailures": r["vectors"]["failedVectors"]} for name, r in report["corpora"].items()}, indent=2))
    raise SystemExit(bool(failures))
