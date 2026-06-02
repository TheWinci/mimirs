# Configuration

This page is the reference for everything that changes how mimirs behaves without touching its logic: the per-project `config.json` file, the three environment variables the process reads, and the precedence rules that decide which embedding model, dimension, pooling, and quantization the index is built at. It is written for a maintainer who needs to know exactly where a setting is read, what it controls, and which seam to edit to add or change one. The runtime behaviors these settings drive live on the flow pages linked throughout; this page ties them together.

There are two configuration surfaces, and they do not overlap. Tunable, project-specific knobs (which files to index, chunk sizes, search weights, benchmark thresholds, embedding model) live in a JSON file on disk at `.mimirs/config.json`. Deployment-level concerns that the process needs before any project file is read (where the project is, where the database goes, how loud the logs are) come from environment variables. Keep new settings on the side that matches this split: a per-project tuning knob belongs in the schema, a per-deployment wiring concern belongs in an env var.

## The config file: schema, defaults, and validation

The config file is `.mimirs/config.json`, one per project. Its shape is a Zod schema, `RagConfigSchema`, and the exported `RagConfig` type is inferred from it (`src/config/index.ts:17-39`). The schema is the single source of truth for what a valid config looks like — every field, its type, its bounds, and its default are declared there, so adding a knob means adding one line to the schema and one line to `DEFAULT_CONFIG` directly below it (`src/config/index.ts:41-127`).

`loadConfig(projectDir)` is the only async loader, and its contract is deliberately blunt: what is on disk is what runs, with no hidden merge (`src/config/index.ts:134-162`). On the first call for a project, the file does not exist, so it writes the full `DEFAULT_CONFIG` to `.mimirs/config.json` (pretty-printed, trailing newline) and returns a copy (`src/config/index.ts:138-142`). This is why a fresh project gets a fully populated, editable config file rather than an empty one — users edit the real defaults in place. On later calls it reads and `JSON.parse`s the file; if the JSON is malformed it logs a warning on the diagnostic channel and returns the defaults (`src/config/index.ts:144-151`). It then runs `RagConfigSchema.safeParse`. On a validation failure it logs the offending field paths and messages and returns the defaults wholesale (`src/config/index.ts:153-159`) — it does not patch individual bad fields, it falls back to the entire default config. So an invalid file never crashes a load; it silently degrades to defaults with a warning, and the bad file is left untouched on disk.

Two kinds of fields are normalized rather than passed through. The `include`, `exclude`, and `generated` lists go through `globList`, a Zod transform that rewrites backslashes to forward slashes (`src/config/index.ts:12-15`). Glob syntax is POSIX, where `\` is an escape character, not a path separator; this transform lets a Windows user write `node_modules\**` and have it work. The indexer also normalizes paths at the storage boundary, so this is defense-in-depth rather than the only guard.

### Config fields and where they are read

Every field below comes from `RagConfigSchema` (`src/config/index.ts:17-37`); the defaults are in `DEFAULT_CONFIG` (`src/config/index.ts:41-127`). The read site is where the value actually changes behavior.

| Field | Type / bounds | Default | What it controls and where it is read |
| --- | --- | --- | --- |
| `include` | string globs | ~70 source/markup/config patterns | Which files the indexer walks. Read during the index flow; surfaced as a pattern count by `server_info` (`src/tools/server-info-tools.ts:52`). See [mimirs index](cli/index.md). |
| `exclude` | string globs | `node_modules`, `.git`, build output, caches, `.mimirs`, etc. | Files skipped before chunking. Defaults already cover the common dependency and build directories (`src/config/index.ts:88-114`). |
| `generated` | string globs | `[]` (empty) | Files indexed but deprioritized in ranking. Threaded into chunk search via `config.generated` (`src/tools/search.ts:68`, `src/tools/search.ts:148`). |
| `chunkSize` | int ≥ 64 | `512` | Target chunk size for the chunker (`src/config/index.ts:21`, `src/config/index.ts:116`). |
| `chunkOverlap` | int ≥ 0 | `50` | Overlap between adjacent chunks (`src/config/index.ts:22`, `src/config/index.ts:117`). |
| `hybridWeight` | 0–1 | `0.5` | Weight toward the primary (vector) list when fusing vector and keyword results by rank (`src/tools/search.ts:68`, `src/tools/search.ts:148`). Higher favors semantic similarity. See the fusion note below. |
| `searchTopK` | int ≥ 1 | `10` | Default result count when a search caller does not pass `top` (`src/tools/search.ts:68`). |
| `indexBatchSize` | int ≥ 1, optional | `50` | Files/chunks embedded per batch during indexing. Falls back to `50` when unset. |
| `indexThreads` | int ≥ 1, optional | unset | Thread count handed to the embedder; when unset the embedder picks a default from CPU count (`src/embeddings/embed.ts:36-38`). |
| `incrementalChunks` | boolean | `false` | Enables re-embedding only changed chunks of a modified file. |
| `embeddingMerge` | boolean | `true` | When true, oversized chunks are embedded as merged token windows; switches `embedBatchMerged` vs `embedBatch` (`src/embeddings/embed.ts:169-209`). |
| `embeddingModel` | string, optional | unset → default model | Hugging Face model id for embeddings (see precedence below). |
| `embeddingDim` | int ≥ 1, optional | unset → default dim | Vector dimension the index is built at (see precedence below). |
| `embeddingPooling` | enum `mean` \| `cls` \| `none`, optional | unset → `mean` | How token embeddings are pooled into one vector for the model (see precedence below). |
| `embeddingDtype` | string, optional | unset → `q8` | ONNX weight quantization, e.g. `q8` or `fp32` (see precedence below). |
| `parentGroupingMinCount` | int ≥ 2 | `2` | Min sibling chunks before they are grouped under a parent in chunk search. |
| `benchmarkTopK` | int ≥ 1 | `5` | Default `top` for benchmark and eval runs (`src/cli/commands/benchmark.ts:18`, `src/cli/commands/eval.ts:19`). |
| `benchmarkMinRecall` | 0–1 | `0.8` | Recall floor; a benchmark run below it is treated as a failure (`src/cli/commands/benchmark.ts:29`). |
| `benchmarkMinMrr` | 0–1 | `0.6` | MRR floor; combined with recall in the same pass/fail check (`src/cli/commands/benchmark.ts:29`). |

`hybridWeight` is not a linear blend of raw scores. Vector cosine scores and BM25 scores live on different, incomparable scales, so the search layer fuses by *rank* instead. Each result list contributes `K/(K+rank)` (with `K = 60`), giving a value in `(0,1]` that is 1 at the top rank, and the two contributions are combined as `hybridWeight * vectorRankScore + (1 - hybridWeight) * textRankScore` (`src/search/hybrid.ts:77-103`). This reciprocal-rank fusion is the single source of truth for both chunk search and conversation search. The default of `0.5` therefore weights vector and keyword evidence equally; raising it toward `1.0` leans on semantic similarity, lowering it toward `0.0` leans on exact identifier matches.

The benchmark thresholds matter because they are the gate, not just a display value: `benchmark` compares the measured recall and MRR against `benchmarkMinRecall` and `benchmarkMinMrr` in a single condition and exits non-zero if either falls short (`src/cli/commands/benchmark.ts:29-31`). To tighten or loosen what counts as a passing index, edit those two config fields — see [mimirs benchmark](cli/benchmark.md).

The `server_info` tool prints the live config for a project so you can confirm what is actually in effect without opening the file. It echoes the chunk sizes, hybrid weight, top-K, the incremental flag, include/exclude pattern counts, and the optional batch/thread settings (`src/tools/server-info-tools.ts:45-58`), alongside the resolved embedding model and dimension and the env-var values described below. See [server_info](tools/server-info.md).

## Environment variables

Three environment variables configure the process itself. They are plain `process.env` reads with literal defaults — there is no env loader and no `.env` parsing — so they take effect only when set in the MCP server config or the shell that launches mimirs.

| Variable | Default | Read at | Purpose |
| --- | --- | --- | --- |
| `RAG_PROJECT_DIR` | `process.cwd()` | `src/server/index.ts:91`, `src/tools/index.ts:26`, `src/main.ts:10` | The project to index and serve. When unset the process falls back to the current working directory — a common misconfiguration the directory guard exists to catch. |
| `RAG_DB_DIR` | `<projectDir>/.mimirs` | `src/db/index.ts:104-105` | Where the SQLite index lives. Override it when the project directory is read-only; the error path for a write failure points the user straight at this variable (`src/db/index.ts:113-121`). |
| `LOG_LEVEL` | `warn` | `src/utils/log.ts:20` | Diagnostic verbosity on stderr: `debug`, `warn`, `error`, or `silent`. Anything unrecognized falls back to `warn` (`src/utils/log.ts:11-21`). |

`RAG_PROJECT_DIR` is the most consequential because it decides which directory becomes "the project." If it is unset and mimirs is launched from a home, root, or other system-level directory, the directory guard refuses to auto-index and tells the user to set the variable in the MCP config (`src/utils/dir-guard.ts:8-39`). The server start flow checks this guard before any indexing work and skips auto-index and the watcher when the directory is unsafe — see [server start](server/start.md).

`RAG_DB_DIR` resolves inside the `RagDB` constructor with a strict precedence: an explicit `customRagDir` constructor argument wins, then `RAG_DB_DIR`, then the project-local `.mimirs` directory (`src/db/index.ts:102-106`). When the chosen directory cannot be created because of `EROFS` or `EACCES`, the constructor throws a message that names exactly which path failed and shows the env-var fix (`src/db/index.ts:110-123`).

`LOG_LEVEL` gates only the MCP diagnostic channel (the `log.debug` / `log.warn` / `log.error` helpers that write to stderr with a `[mimirs]` prefix). The numeric ordering is `debug=0 < warn=1 < error=2 < silent=3`, and a message is dropped when its level sits below the current threshold (`src/utils/log.ts:12-35`). It does not affect CLI user-facing output, which goes to stdout through a separate `cli` helper (`src/utils/log.ts:48-60`). All three resolved values are echoed back by `server_info` so a user can see what the process actually picked up (`src/tools/server-info-tools.ts:32-35`).

## Embedding model, dimension, pooling, and dtype: precedence and the two appliers

The embedding model and its three companion settings are the one area where order of operations is load-bearing, because the index's vector table is physically built at a fixed dimension and an index built at one dimension cannot accept vectors of another.

The default model is `Xenova/all-MiniLM-L6-v2` at 384 dimensions, with `mean` pooling and `q8` quantization, all declared as constants in the embedder module (`src/embeddings/embed.ts:16-24`). Pooling and quantization are model-dependent: sentence-transformers models like all-MiniLM want mean pooling, while BGE/GTE/ModernBERT/Arctic-style models want CLS pooling — so both are configurable to let an alternate ONNX model be pooled and quantized correctly. The embedder keeps the active model id, dimension, pooling, and dtype in module-level singletons; `configureEmbedder(modelId, dim, pooling, dtype)` is the only way to change them, and it clears the cached pipeline and tokenizer whenever any of the four actually changes (`src/embeddings/embed.ts:44-58`). The pooling value is applied at embed time as the `pooling` option passed to the model (`src/embeddings/embed.ts:100`, `src/embeddings/embed.ts:111`), and the dtype is passed as the pipeline's `dtype` when the model loads (`src/embeddings/embed.ts:67`). Everything that produces a vector reads the current singletons through `getEmbeddingDim` and `getModelId` (`src/embeddings/embed.ts:217-225`).

The downloaded ONNX model weights are cached in a global directory shared across every project: `~/.cache/mimirs/models`, set once as the transformers cache dir at module load (`src/embeddings/embed.ts:12-14`). It is deliberately outside any project's `.mimirs` so that models survive `bunx` temp-dir cleanup and are not re-downloaded per project. If a cached model is corrupted, `getEmbedder` deletes that model's subdirectory under the cache and retries the load once (`src/embeddings/embed.ts:77-88`).

The precedence rule is: the project's `config.json` values for `embeddingModel`, `embeddingDim`, `embeddingPooling`, and `embeddingDtype` win when present, otherwise the embedder defaults apply. This rule is implemented in two places, and which one runs depends on the caller.

The async path is `applyEmbeddingConfig(config)`. It takes an already-loaded `RagConfig`, falls back to `DEFAULT_MODEL_ID` / `DEFAULT_EMBEDDING_DIM` when the model and dim are absent, and forwards the optional `embeddingPooling` / `embeddingDtype` straight through to `configureEmbedder` — undefined values let the embedder apply its own `mean` / `q8` defaults (`src/config/index.ts:168-172`). Tool calls take this path: `resolveProject` runs `loadConfig` then `applyEmbeddingConfig` before handing back the DB (`src/tools/index.ts:36-38`).

The synchronous path is `applyEmbeddingConfigFromDisk(projectDir)`, and it exists because of an ordering constraint inside the `RagDB` constructor. The constructor must configure the embedder before it creates the schema, so the vector table is created at the configured dimension rather than the default 384 — but the constructor is synchronous and cannot await `loadConfig`. So `applyEmbeddingConfigFromDisk` does a minimal, best-effort synchronous read of only the four embedding fields straight off disk, validating each one inline (string model, positive integer dim, the three pooling literals, string dtype), falls back to the defaults on a missing or malformed file, and calls `configureEmbedder` (`src/config/index.ts:184-213`). It never writes the file and never validates the rest of the config — the async `loadConfig` owns writing defaults and surfacing warnings. The constructor calls it unconditionally unless a caller opts out (`src/db/index.ts:131-132`). This makes a correctly-sized index correct by construction no matter how the DB was opened.

After the embedder is configured, the constructor enforces the invariant. `assertEmbeddingDimCompatible` reads the stored `vec_chunks` table definition, parses its declared `FLOAT[N]` dimension, and compares it to the currently configured dimension; on a mismatch it throws immediately rather than failing later with a cryptic vec0 insert error (`src/db/index.ts:150-169`). The stored index wins: the message tells the user to restore the previous `embeddingModel` / `embeddingDim` or delete the index to rebuild it. Changing `embeddingDim` on an existing index without rebuilding is therefore a hard error by design, not a silent re-creation.

The one place that opts out is the model-comparison benchmark. It drives the embedder itself across several models against throwaway indexes, so it calls `configureEmbedder` directly and constructs the `RagDB` with `{ autoEmbeddingConfig: false }` to stop the constructor from overwriting that choice with the project's config (`src/cli/commands/benchmark-models.ts:64`, `src/cli/commands/benchmark-models.ts:77`). This is the only intended caller of that opt-out — see [mimirs benchmark-models](cli/benchmark-models.md).

## Where configuration is wired into the lifecycle

The first time configuration matters is at setup. `mimirs init` runs the setup wizard, then on user confirmation constructs a `RagDB` and calls `loadConfig`, which materializes `.mimirs/config.json` with defaults on that first call (`src/cli/commands/init.ts:31-32`). See [mimirs init](cli/init.md). The plain `mimirs index` command relies on the same constructor-side embedding configuration and notes in a comment that no separate `applyEmbeddingConfig` is needed (`src/cli/commands/index-cmd.ts:11-14`); it also lets `--patterns` override `config.include` for that one run (`src/cli/commands/index-cmd.ts:16-19`).

At server startup, the project directory comes from `RAG_PROJECT_DIR`, the directory guard runs first (`src/server/index.ts:91-92`), and `loadConfig` is awaited after the transport is connected and the preflight DB open succeeds (`src/server/index.ts:258`). The resulting config is then threaded into background indexing and the file watcher (`src/server/index.ts:285`). The full startup sequence is on the [server start](server/start.md) page.

## Key source files

- `src/config/index.ts` — the config schema (`RagConfigSchema`), `DEFAULT_CONFIG`, the `loadConfig` loader with its write-defaults-on-first-load behavior, and both embedding appliers (`applyEmbeddingConfig`, `applyEmbeddingConfigFromDisk`).
- `src/embeddings/embed.ts` — the embedder singletons, `configureEmbedder` (model/dim/pooling/dtype), the default model/dim/pooling/dtype constants, the global model cache dir, and the `getEmbeddingDim` / `getModelId` accessors the rest of the system reads.
- `src/search/hybrid.ts` — `rrfFuse` and `mergeHybridScores`, where `hybridWeight` is applied as reciprocal-rank fusion of vector and keyword results.
- `src/db/index.ts` — the `RagDB` constructor that resolves `RAG_DB_DIR`, calls `applyEmbeddingConfigFromDisk` before schema creation, and enforces the embedding-dimension invariant in `assertEmbeddingDimCompatible`.
- `src/server/index.ts` — the server startup path that reads `RAG_PROJECT_DIR` and awaits `loadConfig` before background indexing.
- `src/utils/log.ts` — the `LOG_LEVEL`-gated diagnostic channel and its default.
- `src/utils/dir-guard.ts` — the `checkIndexDir` guard that refuses to index system-level directories when `RAG_PROJECT_DIR` is unset.
- `src/tools/server-info-tools.ts` — surfaces the live env-var and config values for a project.
