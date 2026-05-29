# Configuration

This page is for anyone changing what mimirs reads at startup or adding a new tunable. It maps the complete configuration surface: the per-project `.mimirs/config.json` file, the handful of environment variables, the defaults, and where each setting is actually read in the code. mimirs deliberately keeps configuration small and explicit — there is no layered merge and no flag-overrides-file precedence to reason about. What is on disk is what runs.

## The two configuration sources, and the absence of precedence

There are only two places mimirs takes settings from, and they govern different things, so they never compete:

1. **`.mimirs/config.json`** — the project's behavior: which files to index, how to chunk, how to rank. Loaded and validated by `loadConfig` (`src/config/index.ts:132-160`).
2. **Environment variables** — *where* things live and how loud logging is: `RAG_PROJECT_DIR`, `RAG_DB_DIR`, `LOG_LEVEL`. These are read directly at their use sites, not folded into the config object.

There is no precedence chain because the two sources do not overlap. The config file never decides the project directory or the database location; the environment variables never decide chunk size or include patterns. The one thing that looks like a flag override is the `index_files` tool's `patterns` argument, which substitutes the config's `include` list for that single call only — `const config = patterns ? { ...baseConfig, include: patterns } : baseConfig` (`src/tools/index-tools.ts:25-26`) — and never touches the file on disk. See [index_files](tools/index-files.md).

The loader's contract is "what's on disk is what runs." If `config.json` is missing, `loadConfig` writes the full defaults to disk and returns them, so a user always has a real file to edit (`src/config/index.ts:136-140`). If the file is present but contains invalid JSON, or fails schema validation, `loadConfig` logs a warning and falls back to the complete defaults — it does *not* partially merge valid fields with defaults; a validation failure on any field discards the whole file for that load (`src/config/index.ts:142-159`). When adding a field, that is the behavior to preserve: add it to `RagConfigSchema` and to `DEFAULT_CONFIG`, and accept that a malformed file means full defaults.

## Environment variables

| Variable | Default | Read at | Purpose |
| --- | --- | --- | --- |
| `RAG_PROJECT_DIR` | `process.cwd()` | `resolveProject` (`src/tools/index.ts:26`), server boot (`src/server/index.ts:91`) | The project to index/serve when no `directory` arg is given. |
| `RAG_DB_DIR` | `<projectDir>/.mimirs` | `RagDB` constructor (`src/db/index.ts:96-99`) | Override where `index.db` is written — used when the project dir is read-only. |
| `LOG_LEVEL` | `warn` | logger init (`src/utils/log.ts:20`) | Minimum log level emitted to stderr. |

`RAG_PROJECT_DIR` is the fallback project directory everywhere a `directory` parameter is optional; `resolveProject` resolves `directory || process.env.RAG_PROJECT_DIR || process.cwd()` (`src/tools/index.ts:26`). `RAG_DB_DIR` lets the database live outside the project — the `RagDB` constructor uses it ahead of the `.mimirs` default, and its error messages tell the user to set it when the project directory is not writable (`src/db/index.ts:96-113`). `LOG_LEVEL` defaults to `warn` in the logger (`src/utils/log.ts:20`).

The `server_info` tool reports these back, but note one discrepancy worth knowing when reading its output: it prints `db_dir` as `RAG_DB_DIR` or a `${projectDir}/.rag` fallback (`src/tools/server-info-tools.ts:34`), whereas `RagDB` actually defaults the database to `${projectDir}/.mimirs` (`src/db/index.ts:96-99`). The reported `db_dir` line is therefore only accurate when `RAG_DB_DIR` is set; the real location is `.mimirs`. The boot phase that loads this config is covered by [mimirs serve](server/start.md).

## The config file: every field, its default, and where it is read

`RagConfigSchema` defines the file's shape and per-field defaults; `DEFAULT_CONFIG` is the literal written to disk on first load (`src/config/index.ts:17-125`).

| Field | Default | Read at | Effect |
| --- | --- | --- | --- |
| `include` | broad source/doc/config glob list (`src/config/index.ts:40-85`) | indexer scan; watcher (`src/indexing/watcher.ts:26`) | Which files get indexed. |
| `exclude` | deps/build/cache/`.mimirs` globs (`src/config/index.ts:86-112`) | indexer scan; watcher (`src/indexing/watcher.ts:25`) | Which files are skipped. |
| `generated` | `[]` | `search`/`searchChunks` (`src/tools/search.ts:68`) | Patterns whose matches are demoted in search ranking. |
| `chunkSize` | `512` | chunker (`src/indexing/indexer.ts:445`) | Target chunk size. |
| `chunkOverlap` | `50` | chunker (`src/indexing/indexer.ts:446`) | Overlap between adjacent chunks. |
| `hybridWeight` | `0.7` | `search`/`searchChunks` (`src/tools/search.ts:68,148,307`) | Vector-vs-keyword blend in hybrid ranking. |
| `searchTopK` | `10` | `search` default top (`src/tools/search.ts:68`) | Default result count when `top` is omitted. |
| `indexBatchSize` | `50` | embedding batch (`src/indexing/indexer.ts:390,560`) | Chunks per embedding batch. |
| `indexThreads` | unset | embedder spin-up (`src/indexing/indexer.ts:474,614,742`) | Worker threads for embedding. |
| `incrementalChunks` | `false` | indexer | Incremental chunk re-emit mode. |
| `embeddingMerge` | `true` | embedder | Merge sub-chunk embeddings. |
| `embeddingModel` | unset → `DEFAULT_MODEL_ID` | `applyEmbeddingConfig` (`src/config/index.ts:167`) | Embedding model id. |
| `embeddingDim` | unset → `DEFAULT_EMBEDDING_DIM` | `applyEmbeddingConfig` (`src/config/index.ts:168`) | Embedding vector dimension. |
| `parentGroupingMinCount` | `2` | search grouping | Min sibling chunks before collapsing to parent. |
| `benchmarkTopK` / `benchmarkMinRecall` / `benchmarkMinMrr` | `5` / `0.8` / `0.6` | benchmark/eval commands | Benchmark thresholds. |

Two schema details matter when editing. Glob lists pass through `globList`, which rewrites Windows-style `\` separators to `/` because POSIX globs treat `\` as an escape, not a path separator (`src/config/index.ts:12-15`). And `indexBatchSize`/`indexThreads` are `.optional()` in the schema (`src/config/index.ts:25-26`) — read sites supply their own fallbacks (`config.indexBatchSize ?? 50`), so a missing value is normal, not an error.

## Embedding config is applied separately, and ordering matters

The embedding model and dimension are config fields, but they take effect through a separate call, `applyEmbeddingConfig`, which pushes `embeddingModel`/`embeddingDim` (or their defaults) into the embedder via `configureEmbedder` (`src/config/index.ts:166-170`). Tool handlers get this for free: `resolveProject` calls `loadConfig` and then `applyEmbeddingConfig` before returning (`src/tools/index.ts:34-36`).

The ordering invariant to respect: `applyEmbeddingConfig` must run **before** a fresh `RagDB` is constructed, because `RagDB.initSchema` reads `getEmbeddingDim()` to size the vector tables (`src/db/index.ts:146-149`). If a database is opened before the embedding config is applied, a custom `embeddingDim` will not be reflected in the schema. Any new code path that opens a `RagDB` directly — rather than going through `resolveProject` — must apply the embedding config first.

## How init seeds the project config

A new project is set up with `mimirs init`, which calls `runSetup` to write the config, IDE MCP snippets, and `.gitignore` entries (`src/cli/commands/init.ts:16`). The config-seeding step is `ensureConfig`: it does nothing if `config.json` already exists, and otherwise simply calls `loadConfig`, relying on the loader's own auto-create behavior to write the defaults (`src/cli/setup.ts:92-98`). So there is exactly one place that knows the default file contents — `DEFAULT_CONFIG` in the config module — and both first-time load and `init` go through it. `init` also ensures `.mimirs/` is gitignored (`src/cli/setup.ts:100-112`) and offers to run the first full index, which builds a `RagDB`, loads config, and calls `indexDirectory` (`src/cli/commands/init.ts:29-33`). See [mimirs init](cli/init.md).

## Key source files

- `src/config/index.ts` — `RagConfigSchema`, `DEFAULT_CONFIG`, `loadConfig`, and `applyEmbeddingConfig`: the single source of the config shape, defaults, the no-merge load contract, and embedding application.
- `src/cli/setup.ts` — `ensureConfig`/`ensureGitignore`/`runSetup`: how `mimirs init` seeds the config and gitignore by delegating to the loader.
- `src/db/index.ts` — the `RagDB` constructor's `RAG_DB_DIR` handling and the `initSchema` read of `getEmbeddingDim()` that the embedding-config ordering depends on.
- `src/tools/server-info-tools.ts` — `registerServerInfoTools`: where the resolved config and environment are reported back to the caller.
