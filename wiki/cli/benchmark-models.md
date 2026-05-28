# CLI: benchmark-models

`mimirs benchmark-models` compares several embedding models on the same fixture of queries. For each model it reconfigures the embedder, builds a *fresh temporary index*, runs the benchmark, prints per-model metrics, and at the end emits a markdown comparison table plus a baseline-vs-candidate diff that hints whether any candidate beats the first model by enough recall to be worth switching.

This is the command you run before changing `config.embeddingModel` or the default model in source — it gives you a controlled like-for-like read on how each candidate retrieves on a real codebase.

## Flow

```mermaid
sequenceDiagram
    autonumber
    participant User
    participant CLI as benchmarkModelsCommand
    participant Embed as configureEmbedder
    participant Indexer as indexDirectory
    participant Runner as runBenchmark
    User->>CLI: mimirs benchmark-models <fixture> --models a,b,c [--dir D --top N]
    CLI->>CLI: loadBenchmarkQueries(fixture)
    loop per model
        CLI->>Embed: configureEmbedder(id, dim); resetEmbedder()
        CLI->>CLI: mkdir .rag-eval-<model-id> (temp DB dir)
        CLI->>Indexer: indexDirectory(dir, tmpDb, config)
        Indexer-->>CLI: indexResult + indexTimeMs
        CLI->>Runner: runBenchmark(queries, tmpDb, dir, top, hybridWeight)
        Runner-->>CLI: BenchmarkSummary
        CLI->>CLI: db.close() + rm temp dir
    end
    CLI->>Embed: restore DEFAULT_MODEL_ID
    CLI-->>User: markdown comparison table + baseline diff
```

1. Parse the fixture path and `--models a,b,c` flag. Missing fixture or missing `--models` → usage + `exit(1)` (`src/cli/commands/benchmark-models.ts:32-51`). The usage block also lists known model ids and their dimensions.
2. Each comma-separated model is resolved through `parseModelArg`. Known ids in `KNOWN_MODELS` resolve to their hard-coded `(id, dim)`. Unknown ids must use `model-id:dim` format; otherwise `parseModelArg` throws (`src/cli/commands/benchmark-models.ts:22-30`).
3. Queries are loaded once with `loadBenchmarkQueries`, shared across all models — same fixture, no re-read.
4. For each model: `configureEmbedder(id, dim)` updates the embedder config, `resetEmbedder()` discards the previously-loaded pipeline so the next embed call loads the new one (`src/cli/commands/benchmark-models.ts:62-64`).
5. A fresh temp directory `<dir>/.rag-eval-<model-id-with-slashes-dashed>` is created. If it already exists from a prior run it is wiped first. A new `RagDB` is opened *against the project dir* but with the *temp dir* as its DB location — the constructor takes `(projectDir, dbDir)`. This keeps the production `.mimirs/index.db` untouched.
6. `indexDirectory(dir, db, config, onProgress)` runs a full index. The progress callback rewrites the same line with `\r` so the terminal shows live progress. `indexTimeMs` is measured around the call.
7. `runBenchmark(queries, db, dir, top, config.hybridWeight)` returns the same `BenchmarkSummary` shape as `mimirs benchmark` (recall@K, MRR, zero-miss rate).
8. The temp DB is closed and the temp directory is removed *in a `finally`* so a crashed model run still cleans up.
9. After the loop, the embedder is restored to `DEFAULT_MODEL_ID` / `DEFAULT_EMBEDDING_DIM` so a follow-up command in the same process sees the original config.
10. The comparison table is printed in markdown (`| Model | Dim | Recall@K | MRR | Zero-miss | Index time |`). When more than one model was run, each model is also compared against the *first* model in the `--models` list. The first model acts as the baseline.

## Inputs

| Input | Where it comes from | Effect |
|---|---|---|
| `fixture` (positional) | First arg | JSON file of `{ query, expected[] }` — same format as `mimirs benchmark`. Required. |
| `--dir D` | CLI flag (default `.`) | Project directory to index and search against. |
| `--top N` | CLI flag (default `config.benchmarkTopK`) | top-K used for recall and as the search depth. |
| `--models a,b,...` | CLI flag, required | Comma-separated list. Each item is either a known model id or `id:dim`. The order matters — index 0 is the baseline. |

### Known models

These are hard-coded in `KNOWN_MODELS` (`src/cli/commands/benchmark-models.ts:15-20`):

| Id | Dim |
|---|---|
| `Xenova/all-MiniLM-L6-v2` | 384 |
| `Xenova/bge-small-en-v1.5` | 384 |
| `Xenova/jina-embeddings-v2-small-en` | 512 |
| `jinaai/jina-embeddings-v2-base-code` | 768 |

Any other model must be passed as `model-id:dim`, e.g. `--models my-org/custom-model:512`. The dim is required because the SQLite vector column has a fixed dimensionality per index and must be set up before indexing.

## Outputs

- **Stdout, per-model block**: indexing progress (`\r`-overwritten), final `Indexed N files in Ts`, then `Recall@K`, `MRR`, `Zero-miss` lines.
- **Stdout, final**: a markdown comparison table with one row per model.
- **Baseline diff** (when 2+ models): each candidate compared against the first model — recall delta in percentage points, MRR delta absolute, and one of three verdicts:
  - `>5pp recall improvement → consider making it default`
  - `Marginal improvement — document but keep current default`
  - `No recall improvement`
- **Filesystem side effects**: a temp index dir per model under `<projectDir>/.rag-eval-<model-id>/`. Always removed in `finally`, even on error.

## State changes

- `KNOWN_MODELS` embedder config — flipped per iteration through `configureEmbedder` / `resetEmbedder`, then restored to `DEFAULT_MODEL_ID` after the loop. If the command crashes between iterations, the embedder is left configured for the last-tried model in the *current* process — but since this is a CLI command that exits after, that does not leak into the production server.
- Temp index DBs — created under `<dir>/.rag-eval-<model-id>/` and removed at the end of each iteration. They are not the same directory as `.mimirs/`, so the production index is never touched.

## How model selection feeds back into config

The command does not write to `.mimirsrc` or any config file. The verdict in the baseline diff is advisory: read it, decide whether to swap, then update `embeddingModel` and `embeddingDim` in the project config yourself. The `>5pp` threshold is an opinionated cutoff — small absolute differences with high variance fixtures should not move the needle. Use `mimirs benchmark` once after the swap to confirm the index built with the new model still meets `benchmarkMinRecall` / `benchmarkMinMrr`.

## Branches and failure cases

- Missing fixture / missing `--models` → usage + `exit(1)`; usage also dumps the `KNOWN_MODELS` list.
- Unknown model without `:dim` suffix → `parseModelArg` throws with a hint and the list of known models.
- An existing `<dir>/.rag-eval-<id>/` from a previous run is removed with `rmSync(..., { recursive: true })` before re-creating, so reruns are idempotent.
- An exception during indexing or benchmarking still hits the `finally` block: temp DB closes and temp directory is removed.
- Single-model run: the comparison block at the bottom is skipped because `results.length > 1` gates the baseline diff loop. The markdown table is still printed.

## Example

```sh
mimirs benchmark-models evals/retrieval.json \
  --models Xenova/all-MiniLM-L6-v2,Xenova/bge-small-en-v1.5,jinaai/jina-embeddings-v2-base-code \
  --top 10
```

Illustrative table:

```
=== Comparison ===

| Model | Dim | Recall@10 | MRR | Zero-miss | Index time |
|---|---|---|---|---|---|
| Xenova/all-MiniLM-L6-v2 | 384 | 71.0% | 0.612 | 12.0% | 18.4s |
| Xenova/bge-small-en-v1.5 | 384 | 78.0% | 0.701 | 8.0% | 19.1s |
| jinaai/jina-embeddings-v2-base-code | 768 | 81.0% | 0.733 | 6.0% | 41.7s |

Xenova/bge-small-en-v1.5 vs Xenova/all-MiniLM-L6-v2:
  Recall: +7.0pp
  MRR: +0.089
  → Candidate shows >5pp recall improvement — consider making it default

jinaai/jina-embeddings-v2-base-code vs Xenova/all-MiniLM-L6-v2:
  Recall: +10.0pp
  MRR: +0.121
  → Candidate shows >5pp recall improvement — consider making it default
```

## Related flows

- [cli/benchmark](benchmark.md) — single-model retrieval benchmark. This command reuses `loadBenchmarkQueries` and `runBenchmark` from the same module.
- [cli/eval](eval.md) — agent-simulation A/B (not used here, but shares the fixture-on-disk pattern).

## Key source files

- `src/cli/commands/benchmark-models.ts` — model loop, temp DB lifecycle, comparison table.
- `src/embeddings/embed.ts` — `configureEmbedder`, `resetEmbedder`, `DEFAULT_MODEL_ID`, `DEFAULT_EMBEDDING_DIM`.
- `src/indexing/indexer.ts` — `indexDirectory`, run once per model.
- `src/search/benchmark.ts` — `loadBenchmarkQueries`, `runBenchmark`, `BenchmarkSummary`.
