# CLI: benchmark-models

`mimirs benchmark-models` answers one question: **would switching the embedding model make search measurably better, and by how much?** You give it a set of labelled queries — each query paired with the files you *expect* search to surface — and a list of candidate embedding models. It runs the same search-quality benchmark against each model in turn. For every model it reconfigures the embedder, builds a fresh throwaway index of your project, scores the queries, then at the end prints a side-by-side comparison table plus a verdict on whether any candidate beats the baseline by a meaningful margin.

This is a maintainer/evaluation tool, not part of normal indexing or serving. You reach for it when you are considering changing the default embedding model and want hard recall numbers on real queries before touching `embeddingModel` in config. It never touches your real index: every model gets its own temporary index directory that is deleted as soon as its turn is over.

The command is registered in the CLI dispatcher at `src/cli/index.ts:139-140`, which routes `benchmark-models` to `benchmarkModelsCommand` in `src/cli/commands/benchmark-models.ts:33`.

## How it works

The whole flow lives in one handler, `benchmarkModelsCommand`. The interesting part is the per-model loop. The embedder in `src/embeddings/embed.ts` is a process-wide singleton — there is exactly one active model id and dimension at a time — so the command has to carefully swap models in and out, and keep each model's vectors in a separate index so the differing vector dimensions never collide.

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant Handler as benchmark-models handler
    participant Embed as embedder singleton
    participant Indexer as indexDirectory
    participant DB as temp RagDB
    participant Bench as runBenchmark

    User->>Handler: mimirs benchmark-models queries.json --models a,b
    Handler->>Handler: resolve --dir, loadConfig, parse --top
    Handler->>Handler: split --models, parseModelArg each
    Handler->>Handler: loadBenchmarkQueries(file)
    loop for each model
        Handler->>Embed: configureEmbedder(id, dim) + resetEmbedder()
        Handler->>DB: new RagDB(dir, tmpDir, autoEmbeddingConfig: false)
        Handler->>Indexer: indexDirectory(dir, db, config)
        Indexer->>Embed: embed chunks at this model's dim
        Handler->>Bench: runBenchmark(queries, db, dir, top, hybridWeight)
        Bench-->>Handler: { recallAtK, mrr, zeroMissRate }
        Handler->>DB: close() + rmSync(tmpDir) in finally
    end
    Handler->>Embed: configureEmbedder(DEFAULT) + resetEmbedder()
    Handler->>User: comparison table + >5pp verdict
```

1. The user runs the command with a queries file as the first positional argument and a required `--models` list. The handler reads the file name from `args[1]`; if it is missing it prints usage text plus the list of built-in models and exits with code 1 — `src/cli/commands/benchmark-models.ts:34-42`.
2. Flags are resolved: `--dir` (default `.`) is resolved to an absolute path, the project config is loaded from it, and `--top` is parsed by `intFlag` with a fallback to `config.benchmarkTopK` (default 5) — `src/cli/commands/benchmark-models.ts:44-46`.
3. The `--models` string is required; if absent the handler prints an error with an example and exits 1. Otherwise it is split on commas and each entry is turned into a `{ id, dim }` spec by `parseModelArg` — `src/cli/commands/benchmark-models.ts:47-54`.
4. The labelled queries are loaded and validated by `loadBenchmarkQueries`, which parses the JSON array and checks that every entry has a truthy `query` and a non-empty `expected` array — `src/cli/commands/benchmark-models.ts:55`, `src/search/benchmark.ts:29-44`.
5. For each model, `configureEmbedder(model.id, model.dim)` records the new model and dimension on the singleton, and `resetEmbedder()` clears the cached pipeline and tokenizer so the next embed call reloads the candidate model — `src/cli/commands/benchmark-models.ts:64-65`.
6. A temporary index directory `.rag-eval-<model>` is created inside the project dir (any stale copy is deleted first), and a `RagDB` is opened against it with `autoEmbeddingConfig: false` so the constructor does not overwrite the dimension the command just set — `src/cli/commands/benchmark-models.ts:67-77`.
7. `indexDirectory` walks the project and embeds every chunk into the temp DB at the current model's dimension. The handler times this with `performance.now()` and prints how many files were indexed — `src/cli/commands/benchmark-models.ts:81-87`.
8. `runBenchmark` runs each query through the normal hybrid search against the temp index (passing `config.hybridWeight`, default 0.7) and computes recall@K, mean reciprocal rank, and zero-miss rate — `src/cli/commands/benchmark-models.ts:90-97`, `src/search/benchmark.ts:52-105`.
9. In a `finally` block the DB is closed and the temp directory is removed with `rmSync(..., { recursive: true, force: true })`, so the temp index never survives the model's turn even if indexing or benchmarking threw — `src/cli/commands/benchmark-models.ts:98-102`.
10. After all models are done, the embedder is restored to the project default (`configureEmbedder(DEFAULT_MODEL_ID, DEFAULT_EMBEDDING_DIM)` + `resetEmbedder()`) so the process is left in a clean state — `src/cli/commands/benchmark-models.ts:106-107`.
11. The handler prints a Markdown comparison table and, when more than one model ran, a per-candidate verdict comparing each model against the first — `src/cli/commands/benchmark-models.ts:110-141`.

## Inputs

| Name | Type | Required | Description |
|---|---|---|---|
| `<file>` | positional path | yes | Path to a JSON file of benchmark queries. Each entry is `{ "query": string, "expected": string[] }`, where `expected` lists the file paths search should return for that query. Resolved with `resolve(file)` and read by `loadBenchmarkQueries` — `src/cli/commands/benchmark-models.ts:55`, `src/search/benchmark.ts:29`. |
| `--models m1,m2` | comma-separated string | yes | Models to compare, in order; the first is treated as the baseline. Each entry is either a known model name or a custom `model-id:dim` pair. Missing this flag aborts the run with an error and exit code 1 — `src/cli/commands/benchmark-models.ts:47-54`. |
| `--dir D` | path | no | Project directory to index and benchmark against. Defaults to the current directory and is resolved to absolute — `src/cli/commands/benchmark-models.ts:44`. |
| `--top N` | integer | no | Cutoff K for recall@K and the search depth per query. Defaults to `config.benchmarkTopK` (5). Validated as an integer ≥ 1; bad input fails with a clear flag error — `src/cli/commands/benchmark-models.ts:46`, `src/cli/flags.ts:40-53`. |

### The `--models` value format

`parseModelArg` accepts two forms and rejects everything else — `src/cli/commands/benchmark-models.ts:23-31`:

| Form | Example | Meaning |
|---|---|---|
| Known model name | `Xenova/all-MiniLM-L6-v2` | Looked up in `KNOWN_MODELS`; the dimension is filled in automatically. |
| `model-id:dim` | `some-org/some-model:768` | Any model identifier plus its embedding dimension, split on `:` into exactly two parts; the dimension is `parseInt`-ed. |
| Anything else | `gpt-foo` | Rejected with `Unknown model "..."`, listing the known models. |

The four built-in known models are defined in `KNOWN_MODELS` at `src/cli/commands/benchmark-models.ts:16-21`:

| Model id | Dimension |
|---|---|
| `Xenova/all-MiniLM-L6-v2` | 384 |
| `Xenova/bge-small-en-v1.5` | 384 |
| `Xenova/jina-embeddings-v2-small-en` | 512 |
| `jinaai/jina-embeddings-v2-base-code` | 768 |

`Xenova/all-MiniLM-L6-v2` at 384 dimensions is also the project default model (`DEFAULT_MODEL_ID` / `DEFAULT_EMBEDDING_DIM` in `src/embeddings/embed.ts:16-17`), so putting it first in `--models` makes the comparison a "candidate vs current default" test.

## Outputs

| Output | Where it lands / shape / description |
|---|---|
| Per-model progress | Lines on stdout for each model: a header `--- <id> (<dim>d) ---`, an `Indexed N files in Ms` line, and that model's `Recall@K`, `MRR`, and `Zero-miss` percentages — `src/cli/commands/benchmark-models.ts:61,87,95-97`. |
| Comparison table | A Markdown table printed under `=== Comparison ===` with columns Model, Dim, Recall@K, MRR, Zero-miss, Index time — one row per model — `src/cli/commands/benchmark-models.ts:110-121`. |
| Recall verdict | When more than one model ran, a per-candidate block showing the recall (in percentage points) and MRR difference versus the first model, plus a recommendation line — `src/cli/commands/benchmark-models.ts:124-141`. |
| Temp index directories | One `.rag-eval-<model>` directory created per model inside the project dir, then deleted after that model's run. Not a persistent output — see *State changes* — `src/cli/commands/benchmark-models.ts:67-101`. |

The three quality numbers come straight from `runBenchmark`'s `BenchmarkSummary` (`src/search/benchmark.ts:21-27`, computed at `src/search/benchmark.ts:98-104`):

- **Recall@K** — average over queries of the fraction of a query's expected files that appeared in the top-K results.
- **MRR** — mean reciprocal rank; `1/rank` of the first expected file found, averaged over queries (0 for a query that found none).
- **Zero-miss** — fraction of queries where *no* expected file showed up at all.

A file counts as found when the result path and an expected path match exactly, or one ends with the other. Expected paths are first normalized: relative ones are resolved against the project dir, absolute ones kept as-is. This suffix match lets relative `expected` paths line up with the absolute paths search returns — `src/search/benchmark.ts:46-50,71-74`.

## State changes

### Temporary per-model index directory

| | |
|---|---|
| Before | No `.rag-eval-<model>` directory for the model (any stale one is deleted first). |
| During | The directory and a SQLite index inside it exist, populated with vectors at this model's dimension. |
| After | The directory is removed; the project is left with no trace of the run. |

For each model the handler computes `tmpDir = join(dir, ".rag-eval-<model-id-with-slashes-replaced>")`, deletes any existing copy, then creates it fresh with `mkdirSync`. It opens a `RagDB` pointed at that directory, indexes into it, benchmarks against it, then in a `finally` block closes the DB and removes the directory with `rmSync(tmpDir, { recursive: true, force: true })` — `src/cli/commands/benchmark-models.ts:67-102`.

This matters for two reasons. First, **isolation**: different models produce vectors of different sizes (384, 512, 768…), and the vector table is built at a fixed dimension, so each model needs its own index — reusing one index across dimensions would trip the dimension guard. Second, **safety**: your real `.mimirs` index is never opened, so running this benchmark cannot corrupt or invalidate the index your editor or MCP server is using.

The `autoEmbeddingConfig: false` option is directly tied to this. Normally the `RagDB` constructor reads the project's stored embedding config and applies it *before* creating the vector tables, so the index is built at the configured dimension regardless of call ordering. But here the command has *already* set the embedder to the candidate model, and the default behaviour would reset the dimension back to the project default. Opting out lets the command stay in control of which model is active — `src/db/index.ts:125-132`.

### Embedder singleton model/dim

| | |
|---|---|
| Before each model | Whatever model was active previously (the default on the first iteration). |
| During | The candidate model id and dimension. |
| After the run | Restored to the project default model and dimension. |

`configureEmbedder` only swaps the singleton's recorded model and clears the cached pipeline and tokenizer when the id or dim actually changed; `resetEmbedder` then unconditionally clears the cached extractor and tokenizer so the next embed call reloads — `src/embeddings/embed.ts:35-42,195-199`. Because this state is process-wide, the handler deliberately restores the default at the end so a long-lived process is not left configured for the last candidate — `src/cli/commands/benchmark-models.ts:106-107`.

## Branches and failure cases

- **No queries file** — if `args[1]` is absent, the handler prints usage plus the known-model list and exits with code 1 — `src/cli/commands/benchmark-models.ts:34-42`.
- **Missing `--models`** — prints an error with an example and exits 1 — `src/cli/commands/benchmark-models.ts:49-52`.
- **Unknown model name** — `parseModelArg` throws `Unknown model "..."` when the argument is neither a known model nor a value that splits into exactly two `:`-separated parts — `src/cli/commands/benchmark-models.ts:23-31`.
- **Bad `--top`** — a non-integer or `< 1` value throws a `CliFlagError`, which the top-level dispatcher catches to print the message and exit 1 rather than crash — `src/cli/flags.ts:40-53`, `src/cli/index.ts:96-102`.
- **Invalid benchmark file** — `loadBenchmarkQueries` throws if the JSON is not an array, or if any entry lacks a `query` or has an empty/absent `expected` array — `src/search/benchmark.ts:33-41`.
- **Stale temp directory** — if a previous run died before cleanup and left a `.rag-eval-<model>` directory, it is removed before re-creation, so the index always starts empty — `src/cli/commands/benchmark-models.ts:69`.
- **Indexing or benchmark error mid-loop** — the `try/finally` still closes the DB and deletes the temp directory, so a failure on one model leaves no stray `.rag-eval-*` folder behind. The error then propagates out of the loop, and because cleanup runs but the embedder restore at the end does not, a thrown error leaves the singleton configured for the failing model — `src/cli/commands/benchmark-models.ts:79-102`.
- **Single model** — the run still works and prints the table, but the per-candidate verdict block is skipped because there is no baseline to compare against (`results.length > 1` guard) — `src/cli/commands/benchmark-models.ts:124`.
- **Recall verdict thresholds** — for each candidate after the first, the recall difference in percentage points decides the recommendation — `src/cli/commands/benchmark-models.ts:133-139`:

| Condition | Message |
|---|---|
| `recallDiff > 5` | `→ Candidate shows >5pp recall improvement — consider making it default` |
| `0 < recallDiff ≤ 5` | `→ Marginal improvement — document but keep current default` |
| `recallDiff ≤ 0` | `→ No recall improvement` |

The ">5pp" rule is the practical bar: a model swap churns the whole index and forces everyone to re-embed, so the tool only suggests a default change when the recall gain clears that margin.

## Example

```bash
mimirs benchmark-models bench/queries.json \
  --models Xenova/all-MiniLM-L6-v2,jinaai/jina-embeddings-v2-base-code \
  --dir . --top 5
```

A `bench/queries.json` entry looks like:

```json
[
  { "query": "how does hybrid search combine fts and vectors", "expected": ["src/search/hybrid.ts"] },
  { "query": "where is the embedding model configured", "expected": ["src/embeddings/embed.ts"] }
]
```

The tail of the output has this shape (values illustrative):

```
=== Comparison ===

| Model | Dim | Recall@5 | MRR | Zero-miss | Index time |
|---|---|---|---|---|---|
| Xenova/all-MiniLM-L6-v2 | 384 | 72.0% | 0.640 | 8.0% | 12.3s |
| jinaai/jina-embeddings-v2-base-code | 768 | 81.0% | 0.710 | 4.0% | 41.7s |

jinaai/jina-embeddings-v2-base-code vs Xenova/all-MiniLM-L6-v2:
  Recall: +9.0pp
  MRR: +0.070
  → Candidate shows >5pp recall improvement — consider making it default
```

The first model in `--models` is the baseline, so order matters: put your current default first to read every later row as a candidate against it.

## Relationship to the other benchmark commands

| Command | Scope | Index used | Output |
|---|---|---|---|
| [benchmark](benchmark.md) | One model — your current config | Your real `.mimirs` index | Quality report for the active model |
| `benchmark-models` | Several models compared | A throwaway temp index per model | Comparison table + recall verdict |
| [eval](eval.md) | Search-on vs search-off | Your real index | A/B answer-quality eval |

All three share `runBenchmark` and the benchmark types in `src/search/benchmark.ts`. `benchmark-models` is the only one that re-indexes from scratch per run, because it has to build a separate index for each candidate model.

## Key source files

- `src/cli/commands/benchmark-models.ts` — the command handler: model parsing, the per-model index/benchmark loop, cleanup, and the comparison/verdict output.
- `src/cli/index.ts` — CLI dispatcher that routes `benchmark-models` to the handler and catches flag errors.
- `src/embeddings/embed.ts` — the embedder singleton; `configureEmbedder` / `resetEmbedder` are what let the command swap models, and `DEFAULT_MODEL_ID` / `DEFAULT_EMBEDDING_DIM` are restored at the end.
- `src/search/benchmark.ts` — `loadBenchmarkQueries` and `runBenchmark`, which validate the query file and compute recall@K, MRR, and zero-miss rate.
- `src/indexing/indexer.ts` — `indexDirectory`, which builds each model's temp index and reports `indexed` file counts.
- `src/db/index.ts` — `RagDB`, whose `autoEmbeddingConfig: false` option keeps the constructor from overriding the model the command selected.
