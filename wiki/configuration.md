# Configuration

This page covers everything that changes mimirs' behavior without a code edit: the `.mimirs/config.json` file, the handful of env vars the server reads, and how `mimirs init` seeds them. It's for someone tuning indexing or search behavior, or trying to run mimirs in a constrained environment (read-only filesystem, custom DB location, alternate embedding model).

## Sources of config

There are three sources, and they don't merge.

| Source | Read by | Notes |
| --- | --- | --- |
| `.mimirs/config.json` | `loadConfig` at `src/config/index.ts:131-160` | The project's authoritative config. Auto-created with defaults on first read. |
| `RAG_PROJECT_DIR` env var | `resolveProject` at `src/tools/index.ts:21-37`; `serveCommand` at `src/cli/commands/serve.ts:5` | Which project the process operates on. Falls back to the `directory` tool argument, then `process.cwd()`. |
| `RAG_DB_DIR` env var | `RagDB` constructor at `src/db/index.ts:92-117` | Override where `index.db` lives. Without this, the DB is at `<projectDir>/.mimirs/index.db`. |
| `LOG_LEVEL` env var | `src/utils/log.ts`; surfaced by `server_info` at `src/tools/server-info-tools.ts:35` | Controls server-side logging verbosity (default `warn`). |
| CLI flags (per-command) | `src/cli/index.ts:80-83` (`getFlag`) and each command | Override config for one invocation; never written back to disk. |

The contract on `.mimirs/config.json` is "what's on disk is what runs" — see the comment at `src/config/index.ts:127-131`. There is no merge with hard-coded defaults at runtime. Instead, when the file is missing, `loadConfig` writes the entire `DEFAULT_CONFIG` to disk so the user can edit it directly. When the file exists but a field is invalid, the loader logs a warning and falls back to the full default set rather than silently using a partial config (`src/config/index.ts:151-157`).

## What's in config.json

The schema lives at `src/config/index.ts:17-35` and the defaults at `src/config/index.ts:39-125`. The fields that matter operationally:

| Field | Default | Read by |
| --- | --- | --- |
| `include` | ~80 globs across source, docs, build, infra | `src/indexing/indexer.ts` (collectFiles) and `src/indexing/watcher.ts:24-30` |
| `exclude` | `node_modules`, `.git`, `dist`, `.mimirs/**`, etc. | Same as above |
| `generated` | `[]` | Hybrid search demotion at `src/search/hybrid.ts:377-381` |
| `chunkSize` | 512 | Chunker; surfaced in `server_info` (`src/tools/server-info-tools.ts:47`) |
| `chunkOverlap` | 50 | Chunker |
| `hybridWeight` | 0.7 | Score blend in `src/search/hybrid.ts:336` (vector vs FTS) |
| `searchTopK` | 10 | Default `top` for the `search` tool when caller omits it |
| `indexBatchSize` | 50 (default const, optional in schema) | Batch size for chunk inserts |
| `indexThreads` | unset | Worker-thread count passed to the embedder (`src/indexing/indexer.ts:741-742`) |
| `incrementalChunks` | `false` | Whether to diff chunks at file level instead of replacing all |
| `embeddingMerge` | `true` | Merge sub-chunks at embed time |
| `embeddingModel` / `embeddingDim` | unset → `DEFAULT_MODEL_ID` / `DEFAULT_EMBEDDING_DIM` | `applyEmbeddingConfig` at `src/config/index.ts:166-170` |
| `parentGroupingMinCount` | 2 | `groupByParent` threshold in `src/search/hybrid.ts` |
| `benchmarkTopK` / `benchmarkMinRecall` / `benchmarkMinMrr` | 5 / 0.8 / 0.6 | `mimirs benchmark` thresholds |

Glob lists are normalized at parse time: Windows-style `\` separators get rewritten to `/` (`src/config/index.ts:12-15`), so a config copied from a Windows project still works on POSIX.

## How embedding config takes effect

`applyEmbeddingConfig` at `src/config/index.ts:166-170` calls `configureEmbedder(model, dim)` on the singleton. Both the server (via `resolveProject` called from every tool handler) and CLI commands call this. Because the embedder is a process-level singleton, you cannot change models mid-process — switching `embeddingModel` in `config.json` only takes effect after restarting the server. Worse, the vector tables are created with `FLOAT[dim]` baked in by interpolation (`src/db/index.ts:148`, `244`, `284`, `325`, `365`), so changing `embeddingDim` requires deleting `.mimirs/index.db` and re-indexing.

## Precedence

Within a single process, precedence is: tool argument > env var > config default. Concretely:

- The `directory` argument on every MCP tool (e.g. `search({ directory })`) wins over `RAG_PROJECT_DIR`, which wins over `process.cwd()` (`src/tools/index.ts:26`).
- The `patterns` argument on `index_files` wins over `config.include` for that one call only (`src/tools/index-tools.ts:24-26`); it doesn't update `.mimirs/config.json`.
- CLI flags like `--dir`, `--top`, `--threshold` override per-invocation; the persisted config is not touched.
- `RAG_DB_DIR` overrides the default `<projectDir>/.mimirs/index.db` location (`src/db/index.ts:95-99`). This is the escape hatch for read-only project directories — set it to `/tmp/my-project-rag` and the process can still index.

See [server_info](tools/server-info.md) for the in-band view of resolved values and [index_files](tools/index-files.md) for the per-call patterns override.

## How `mimirs init` seeds config

`initCommand` at `src/cli/commands/init.ts:10-88` calls `runSetup` (`src/cli/setup.ts:324-340`), which composes four idempotent steps:

- `ensureConfig` at `src/cli/setup.ts:92-98` — if `.mimirs/config.json` is absent, calls `loadConfig` which writes the full defaults. If present, it's left alone.
- `ensureAgentInstructions` at `src/cli/setup.ts:162-215` — writes `CLAUDE.md`, `.cursor/rules/mimirs.mdc`, `.windsurf/rules/mimirs.md`, `.junie/guidelines/mimirs.md`, or `.github/copilot-instructions.md` with the MCP tool block. Selection is auto-detected from existing IDE directories, or forced by the `--ide` flag (`claude,cursor,windsurf,copilot,jetbrains,all`).
- `ensureMcpJson` at `src/cli/setup.ts:258-295` — adds a `mimirs` entry under `mcpServers` in `.mcp.json`, `.cursor/mcp.json`, `.junie/mcp.json`, and the Windsurf global configs under `~/.codeium/`. The snippet is built by `mcpServerEntry` at `src/cli/setup.ts:228-234` and uses `bunx mimirs@latest serve` with `RAG_PROJECT_DIR` set to the absolute project path.
- `ensureGitignore` at `src/cli/setup.ts:100-112` — adds `.mimirs/` to `.gitignore` if not already present.

All four are idempotent and safe to re-run; the marker `<!-- mimirs -->` at `src/cli/setup.ts:8` prevents double-injection of agent instructions.

After setup, `init` optionally runs a first index against the new config (`src/cli/commands/init.ts:29-86`), reusing the same `indexDirectory` entry point that the server and the `index_files` tool use.

## Key source files

- `src/config/index.ts` — schema, defaults, loader, embedder configuration.
- `src/cli/setup.ts` — `ensureConfig`, `ensureGitignore`, IDE rule/MCP injection, and `runSetup` composer.
- `src/cli/commands/init.ts` — the user-facing `mimirs init` flow that drives `runSetup` and optionally indexes.
- `src/tools/server-info-tools.ts` — surfaces the resolved config back to the caller for diagnostics.
- `src/tools/index-tools.ts` — shows how `patterns` overrides `config.include` per call.
- `src/db/index.ts` — reads `RAG_DB_DIR` and applies it to the database file location.
