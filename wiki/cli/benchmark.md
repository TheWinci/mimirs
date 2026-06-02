# CLI: benchmark

`mimirs benchmark <file>` measures how good the search index is at finding the
files you expect. You write a small JSON file of queries paired with the file
paths that *should* come back, run the command, and it reports recall and mean
reciprocal rank (MRR). If quality drops below configured thresholds the process
exits non-zero, so the command doubles as a CI gate that fails a build when a
change makes search worse.

This is the regression-testing tool for retrieval quality. Use it after tuning
the hybrid scoring weight, swapping an embedding model, or changing chunking, to
confirm the index still surfaces the right files. It runs real searches against
the live database for the project directory — it does not re-index and does not
mutate any stored state.

## Trigger and flow

The command is dispatched from the CLI router. When the first argument is
`benchmark`, the router calls `benchmarkCommand` with the raw argument list and
a `getFlag` helper that reads `--flag value` pairs out of `args`
(`src/cli/index.ts:143-145`).

```mermaid
sequenceDiagram
  autonumber
  participant User
  participant Router as cli/index.ts
  participant Handler as benchmarkCommand
  participant Loader as loadBenchmarkQueries
  participant Runner as runBenchmark
  participant Search as hybrid search
  participant DB as RagDB
  User->>Router: mimirs benchmark queries.json --top 10
  Router->>Handler: benchmarkCommand(args, getFlag)
  Handler->>Handler: read &lt;file&gt; arg, exit 1 if missing
  Handler->>DB: new RagDB(dir)
  Handler->>Handler: loadConfig(dir), resolve --top via intFlag
  Handler->>Loader: loadBenchmarkQueries(file)
  Loader-->>Handler: BenchmarkQuery[] (or throw on bad JSON)
  loop each query
    Runner->>Search: search(query, db, topK, 0, weight, generated)
    Search->>DB: vector + BM25 lookup
    Search-->>Runner: DedupedResult[] (one per file)
    Runner->>Runner: compute recall + reciprocal rank
  end
  Runner-->>Handler: BenchmarkSummary
  Handler->>User: print formatted report
  Handler->>DB: db.close()
  Handler->>Handler: exit 1 if recall &lt; min OR mrr &lt; min
```

1. The user runs `mimirs benchmark <file>` with an optional `--dir` and `--top`.
   The router matches the `benchmark` case and invokes the handler
   `benchmarkCommand` (`src/cli/index.ts:143-145`).
2. The handler reads the query file path from `args[1]`. If it is absent it
   prints a usage line and exits with code `1`
   (`src/cli/commands/benchmark.ts:9-13`).
3. It resolves the target directory from `--dir` (defaulting to the current
   directory), opens the project database with `new RagDB(dir)`, and loads the
   project config (`src/cli/commands/benchmark.ts:15-17`).
4. It resolves how many results each query should retrieve. The `--top` flag is
   parsed through `intFlag`, falling back to `config.benchmarkTopK` (default
   `5`) and requiring a value of at least `1`
   (`src/cli/commands/benchmark.ts:18`).
5. It loads and validates the query file, then prints a one-line status of how
   many queries will run against which directory
   (`src/cli/commands/benchmark.ts:20-21`).
6. `runBenchmark` runs each query through the same hybrid search the rest of
   mimirs uses, scoring whether the expected files appear in the top-K results
   (`src/cli/commands/benchmark.ts:23`).
7. The summary is formatted into a human-readable report and printed; the
   database handle is closed (`src/cli/commands/benchmark.ts:24-26`).
8. Finally, the handler compares the measured recall and MRR against the
   configured minimums and calls `process.exit(1)` if either falls short
   (`src/cli/commands/benchmark.ts:29-31`).

## Loading the benchmark queries

The query file is read and parsed by `loadBenchmarkQueries`, which expects a
JSON array of `{ query, expected }` objects (`src/search/benchmark.ts:29-44`).
The shape is fixed by the `BenchmarkQuery` interface: `query` is the search
string, and `expected` is an array of file paths (relative or absolute) that the
search should return for that query (`src/search/benchmark.ts:7-10`).

Validation is strict and fails fast. If the top-level JSON is not an array, the
loader throws `Benchmark file must be a JSON array of { query, expected }
objects` (`src/search/benchmark.ts:33-35`). For each entry, a missing `query`, a
non-array `expected`, or an empty `expected` list throws an error naming the
offending entry (`src/search/benchmark.ts:37-41`). These throws are not caught
inside the handler, so a malformed file surfaces as a stack trace and a non-zero
exit from the runtime rather than a clean usage message.

A minimal queries file looks like this:

```json
[
  { "query": "how does hybrid search merge scores", "expected": ["src/search/hybrid.ts"] },
  { "query": "where are numeric CLI flags validated", "expected": ["src/cli/flags.ts"] }
]
```

## Running the benchmark and scoring

`runBenchmark` is the scoring engine (`src/search/benchmark.ts:52-105`). It loads
the config for the project directory and picks the hybrid weight from the
optional `hybridWeight` argument, falling back to `config.hybridWeight` (default
`0.5`) (`src/search/benchmark.ts:59-60`). The CLI does not pass an override, so
the benchmark uses the project's configured weight — the same one real searches
use.

For each query it calls `search(q.query, db, topK, 0, weight, config.generated)`
— the file-level hybrid search that fuses vector similarity with BM25 keyword
matching and deduplicates by file path (`src/search/benchmark.ts:65`). The
fourth argument is the score threshold, passed as `0`, so no results are
filtered out by score. The returned `DedupedResult[]` carries one entry per file
path with its best score and matching snippets (`src/search/hybrid.ts:40-44`),
which is exactly the granularity the benchmark needs because expectations are
expressed as file paths.

Path matching is deliberately lenient. Expected paths are normalized: absolute
paths (those starting with `/`) are kept as-is, and relative ones are resolved
against the project directory (`src/search/benchmark.ts:46-50`). A result counts
as a match if the result path equals the expected path, or either one ends with
the other (`src/search/benchmark.ts:71-73`). The suffix check means
`src/search/hybrid.ts` matches a fully-resolved absolute path ending in that
suffix, so you can write short relative paths in the query file without worrying
about the absolute form stored in the index.

Two per-query metrics are computed, recorded as a `BenchmarkResult` per query
(`src/search/benchmark.ts:12-19`):

| Metric | Meaning | How it is computed |
| --- | --- | --- |
| `recall` | Fraction of the expected files that appeared in the top-K results | `found.length / expectedNormalized.length` (`src/search/benchmark.ts:71-74`) |
| `reciprocalRank` | `1 / rank` of the *first* expected file in the ranked results, `0` if none appear | Scans results in order, stops at the first expected match (`src/search/benchmark.ts:77-86`) |
| `hit` | Whether at least one expected file was found | `found.length > 0` (`src/search/benchmark.ts:94`) |

After all queries run, the per-query numbers are aggregated into a
`BenchmarkSummary` (`src/search/benchmark.ts:98-104`):

- `recallAtK` is the mean of every query's `recall`.
- `mrr` is the mean of every query's `reciprocalRank`.
- `zeroMissRate` is the fraction of queries where `hit` was false — queries that
  surfaced *none* of their expected files.
- `total` is the query count, and `results` keeps the full per-query detail used
  by the report.

All three averages guard against an empty query set by returning `0` when
`total` is `0`, so a zero-length (but still valid) array does not divide by zero
(`src/search/benchmark.ts:99-102`).

## The report

`formatBenchmarkReport` turns the summary into the printed text
(`src/search/benchmark.ts:107-139`). The header reports the query count and
top-K, followed by `Recall@K` as a percentage, `MRR` to three decimals, and the
zero-miss rate as a percentage with the absolute miss count in parentheses
(`src/search/benchmark.ts:110-113`).

The report then drills into problems so you can see *why* a number is low,
rather than just the aggregate:

- **Missed queries** — every query with `hit === false` is listed with its
  expected files and what actually came back (or `(no results)` when the search
  returned nothing) (`src/search/benchmark.ts:116-127`).
- **Partial matches** — queries that found *some* but not all expected files
  (`hit` true, `recall < 1`) are listed with their recall percentage
  (`src/search/benchmark.ts:130-136`).

A clean run with no misses and no partials prints only the four summary lines.

```text
Benchmark results (2 queries, top-5):
  Recall@5:      50.0%
  MRR:            0.500
  Zero-miss rate: 50.0% (1 queries)

Missed queries (no expected file in results):
  "where are numeric CLI flags validated"
    expected: src/cli/flags.ts
    got:      src/cli/index.ts, src/cli/commands/search-cmd.ts
```

## Exit code and CI gating

The non-zero exit is what makes this command useful in automation. After
printing the report and closing the database, the handler checks both quality
gates: if `summary.recallAtK < config.benchmarkMinRecall` **or**
`summary.mrr < config.benchmarkMinMrr`, it calls `process.exit(1)`
(`src/cli/commands/benchmark.ts:29-31`). Either threshold failing is enough to
fail the run.

The default thresholds are `benchmarkMinRecall = 0.8` and `benchmarkMinMrr =
0.6`, both configurable in the project config and validated to the `0..1` range
by the schema (`src/config/index.ts:35-36`). A run that meets or exceeds both
thresholds falls through to a normal exit (code `0`).

| Outcome | Exit code | Cause |
| --- | --- | --- |
| Missing `<file>` argument | `1` | Usage printed, no work done (`src/cli/commands/benchmark.ts:10-13`) |
| Recall or MRR below threshold | `1` | Either gate failed (`src/cli/commands/benchmark.ts:29-31`) |
| Both gates passed | `0` | Normal completion |
| Malformed query file | non-zero | Uncaught throw from the loader (`src/search/benchmark.ts:33-41`) |
| Bad `--top` value | `1` | `CliFlagError` caught by the router (`src/cli/flags.ts:40-53`, `src/cli/index.ts:101-104`) |

## Inputs

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `<file>` | path (positional `args[1]`) | Yes | Path to the JSON query file. Resolved to an absolute path before loading. Missing value triggers the usage message and exit `1`. |
| `--dir D` | path flag | No | Project directory whose index is benchmarked. Defaults to the current directory. Determines which `RagDB` is opened and where the config is loaded from (`src/cli/commands/benchmark.ts:15-17`). |
| `--top N` | integer flag | No | Number of results retrieved per query (the K in recall@K and the cutoff for MRR). Defaults to `config.benchmarkTopK` (`5`), must be `>= 1` (`src/cli/commands/benchmark.ts:18`). |

The query file itself contributes structured input: each entry's `query` string
and its `expected` file-path list, validated by `loadBenchmarkQueries`.

## Outputs

| Output | Where it lands / shape / description |
| --- | --- |
| Status line | Printed to stdout before scoring: how many queries run against which directory (`src/cli/commands/benchmark.ts:21`). |
| Benchmark report | Printed to stdout: recall@K, MRR, zero-miss rate, plus per-query miss and partial-match detail (`src/search/benchmark.ts:107-139`). |
| Exit code | `0` when both thresholds pass, `1` when recall or MRR falls below the configured minimum, also `1` on missing argument or bad flag (`src/cli/commands/benchmark.ts:29-31`). |

## State changes

This command does not write to the index, config, or any persistent store. It
opens a `RagDB` connection, runs read-only searches, and closes the handle
before exiting (`src/cli/commands/benchmark.ts:16`,
`src/cli/commands/benchmark.ts:26`). The only externally observable effects are
the printed report and the process exit code. No rows are inserted, no files are
re-indexed, and the query file is read but never modified.

## Branches and failure cases

- **Missing query file argument** — `args[1]` is undefined, so the handler
  prints `Usage: mimirs benchmark <file> [--dir D] [--top N]` and exits `1`
  before opening the database (`src/cli/commands/benchmark.ts:10-13`).
- **Invalid `--top` value** — a non-integer or sub-`1` value makes `intFlag`
  throw a `CliFlagError`; the router's `try/catch` prints the message and exits
  `1` rather than crashing (`src/cli/flags.ts:46-52`, `src/cli/index.ts:101-104`).
- **Malformed query file** — non-array JSON or an entry missing `query` /
  `expected` throws inside `loadBenchmarkQueries`. This is not caught in the
  handler, so it propagates as a runtime error and non-zero exit
  (`src/search/benchmark.ts:33-41`).
- **Query that returns no results** — recorded as a miss; the report lists it
  under missed queries with `got: (no results)`
  (`src/search/benchmark.ts:122-125`).
- **Partial recall** — a query that finds some but not all expected files has
  `recall` between `0` and `1` and `hit === true`; it appears in the partial
  matches section (`src/search/benchmark.ts:130-136`).
- **Empty query array** — a valid empty array passes validation; the aggregates
  guard against division by zero and return `0` for recall and MRR, which then
  fails both default thresholds and exits `1`
  (`src/search/benchmark.ts:99-102`).
- **Below-threshold quality** — either `recallAtK < benchmarkMinRecall` or
  `mrr < benchmarkMinMrr` triggers exit `1`
  (`src/cli/commands/benchmark.ts:29-31`).
- **FTS unavailable** — inside the hybrid search, if the BM25 text query fails it
  logs at debug level and falls back to vector-only results, so the benchmark
  still completes (`src/search/hybrid.ts:349-350`).

## Example

```bash
# Run the default top-5 benchmark against the current project
mimirs benchmark queries.json

# Benchmark a specific project with a wider top-10 cutoff
mimirs benchmark ./bench/queries.json --dir ../other-project --top 10
```

In CI, the exit code is the contract:

```bash
mimirs benchmark queries.json || {
  echo "Search quality regressed below thresholds"
  exit 1
}
```

## Related commands

- [benchmark-models](benchmark-models.md) — reuses the same `runBenchmark`
  engine to compare retrieval quality across multiple embedding models, rather
  than gating a single index against thresholds.
- [eval](eval.md) — a sibling quality-evaluation command in the same CLI family.

## Key source files

| File | Role |
| --- | --- |
| `src/cli/index.ts` | CLI router; dispatches the `benchmark` case to the handler and catches flag errors. |
| `src/cli/commands/benchmark.ts` | Command handler: argument parsing, config loading, orchestration, report printing, and the threshold exit. |
| `src/search/benchmark.ts` | Scoring service: query loading/validation, per-query recall and reciprocal rank, summary aggregation, and report formatting. |
| `src/search/hybrid.ts` | The `search` function each query runs through; defines `DedupedResult`. |
| `src/config/index.ts` | Defines `benchmarkTopK`, `benchmarkMinRecall`, `benchmarkMinMrr`, and `hybridWeight` defaults. |
| `src/cli/flags.ts` | `intFlag` validation for `--top`. |
