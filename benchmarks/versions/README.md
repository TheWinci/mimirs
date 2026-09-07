# Three-version comparison

The later [TS v2 retrieval reference](port/CONTRACT.md) captures the active
implementation and controlled fixtures for the Rust port. Its
[q8 baseline](port/baseline/BASELINE.md) reuses the TS results and records the
three development corpora separately. The completed
[four-corpus verification](port/kubernetes/FOUR-CORPUS.md) includes the final
Kubernetes checkpoint after language expansion. The original results below
remain the historical float32 Rust comparison.

Compare published npm Mimirs 1.8.0, archived TypeScript v2 at
`122674c8bfbbc3549390743f51396c5f0e4e3537`, and Rust at `35dd0d3`.
This measures the products with their production retrieval implementations.
It does not isolate the effect of implementation language.

## Reproduce on macOS

Requires Bun, npm, Python 3.12+, Git, the current Rust release binary, and local
Git objects for the corpus revisions in `prepare.py`. The runner uses macOS
`/usr/bin/time -l` to collect process CPU time and peak resident memory.

```sh
python3 benchmarks/versions/setup.py --root /tmp/mimirs-comparison --binary target/release/mimirs
python3 benchmarks/versions/prepare.py --repos /Users/winci/repos --output /tmp/mimirs-comparison/corpora
python3 benchmarks/versions/provenance.py --root /tmp/mimirs-comparison
python3 -m unittest discover -s benchmarks/versions -p 'test_*.py'
python3 benchmarks/versions/run.py --root /tmp/mimirs-comparison
```

Models must already be cached for cached-model timings. Setup downloads package
dependencies, but does not prewarm embedding models. Record model acquisition
separately when testing a new machine. Never label a download-containing first
run as cached. `provenance.py` records asset checksums and host details.

## Fixed inputs

The four query arrays are byte-for-byte copies of the original benchmark at
`v1.7.1`. Together they contain 382 queries. Expected labels are filenames, not
answer spans. `corrections.json` records one verified rename in Excalidraw:
`laser-trails.ts` became `laserTrails.ts`. No query was dropped or retuned after
looking at retrieval results.

`prepare.py` extracts tracked UTF-8 source files from pinned Git revisions.
All three engines receive identical source bytes and include/exclude rules.
Mimirs uses 80 historical TypeScript source files. Excalidraw uses JS/TS,
Django uses Python, and Kubernetes uses Go without vendored code, `_test.go`,
or the root `test`, `third_party`, and `hack` directories. See each generated
manifest for the exact included files and SHA-256 hashes.

## Measurements

- Three sequential fresh indexes with cached model files, three unchanged
  indexes, and three indexes after appending a valid comment to the two largest
  source files referenced by the query labels. Wall time includes process startup. Edits are identical across
  engines. Baseline bytes are restored before scoring searches.
- Three embedding threads for TypeScript, three single-threaded embedding
  workers for Rust, on a ten-logical-CPU host. This bounds embedding parallelism;
  it is not an operating-system CPU quota.
- File Recall@5/10/20 is the fraction of expected files returned, averaged over
  queries. MRR@20 is reciprocal rank of the first expected file, or zero.
  Repeated owner hits collapse to their first occurrence. Missing all expected
  files counts as a miss. Results outside the first twenty distinct files do
  not count.
- v1 and v2 request twenty file results. Rust requests one hundred owner
  results, then keeps the first twenty distinct files. This accommodates the
  different public result units, but is not an equal candidate-computation
  budget. Record underfilled results. File recall does not prove that the
  returned snippet contains the answer.
- TypeScript quality uses each engine's production search API. One untimed
  warmup precedes three sequential passes through every query. Initialization
  and first-query time are recorded separately. Rust uses the public CLI;
  there is no persistent Rust search latency measurement in this comparison.
- End-to-end CLI latency uses the same ten evenly spaced queries per corpus,
  repeated three times for every engine. This includes model loading, database
  opening, retrieval, formatting, and process exit. CLI latency and persistent
  search latency are separate measurements.
- Raw stdout/stderr, timings, per-query rankings, index counts, coverage, and
  index disk bytes are retained. First indexes remain available for inspection.
  Other disposable trial directories are removed after measurement.

Rust uses Qdrant's float32 MiniLM artifact with a 512-token limit. TypeScript
uses the pinned Xenova quantized MiniLM artifact with 256-token windows.
v1, v2, and Rust also have different chunk, graph, and retrieval policies.
A speed or score difference is not evidence that Rust itself caused it.

These legacy queries contain many code identifiers. They measure this fixed
suite, not broad natural-language retrieval quality. They do not provide gold
answer spans, so an answer-evidence score requires a separately labeled suite.

## Saved run

The September 6, 2026 run writes its durable summaries to `results/RESULTS.md`
and `results/summary.json`. Each completed engine/corpus pair updates those
files. `summary.json` lists incomplete pairs explicitly. The detailed command
logs and retained indexes are under `/tmp/mimirs-three-way/` on the measuring
machine. Source manifests, model checksums, and query-level rankings are saved
here in the repository.

The pilot initially needed two adapter corrections: v1 returns absolute paths,
and v2 requires an explicit absolute source directory in its initialized
config. CLI/API parity checks verified all thirty pilot CLI samples per
TypeScript engine after these corrections. An initial Excalidraw run used
edits to large encoded WebAssembly files that v1 skips. Its measurements are
excluded; the final edit protocol selects the two largest files referenced by
the fixed query labels. This selects the same pilot edit targets as before.

The Rust retrieval port has a separate [three-corpus adoption report](port/adoption/ADOPTION.md), with exact TS v2 rank comparisons, source/vector parity, and costs. Kubernetes is deferred until the language work is complete.
