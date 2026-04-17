# Architecture

`mimirs` is a local RAG index for semantic code search — a Bun process that embeds a project's files into a SQLite database (with `sqlite-vec` and FTS5 loaded), exposes an MCP server for Claude Code / Cursor / Windsurf to query, and ships a CLI with the same surface. The codebase is organised as thirteen cohesive modules under `src/`, each behind an entry file that re-exports a narrow surface. The three highest-fan-in modules are `embeddings` (one file, imported 17× — the single embedder singleton), `db` (10 files behind `RagDB`, imported 15× — the persistence boundary), and `tests` (the fixture helpers every test suite reaches for).

Entry file for the CLI: `src/main.ts` → `src/cli/index.ts`. Entry file for the MCP server: `src/server/index.ts` (loaded dynamically by `src/cli/commands/serve.ts` so module-load failures write a diagnostic instead of crashing silently).

## System Map

```mermaid
flowchart LR
  subgraph Surface["Entry surfaces"]
    cli["cli/ (mimirs command)"]
    mcp["server/ (MCP stdio)"]
    tools["tools/ (MCP registration)"]
  end
  subgraph Pipelines["Pipelines"]
    indexing["indexing/"]
    search["search/"]
    wiki["wiki/"]
    conv["conversation/"]
  end
  subgraph Services["Services"]
    embed["embeddings/ (MiniLM)"]
    graphmod["graph/ (resolver)"]
  end
  subgraph Store["Storage"]
    db["db/ (RagDB)"]
    sqlite[("SQLite + vec0 + FTS5")]
  end

  mcp --> tools
  cli --> indexing
  cli --> search
  tools --> indexing
  tools --> search
  tools --> wiki
  tools --> conv
  indexing --> embed
  indexing --> graphmod
  search --> embed
  wiki --> graphmod
  conv --> embed
  indexing --> db
  search --> db
  wiki --> db
  conv --> db
  db --> sqlite
```

Control flows left-to-right. State lives in one place: the SQLite database behind the `RagDB` facade. The invariant that holds everywhere is **no module outside `db/` opens a `Database` handle directly** — `embeddings`, `search`, `wiki`, `conversation`, and the graph resolver all hold a `RagDB` and call methods on it. FTS sync is enforced by triggers, so callers can't forget to update the virtual tables; vector column widths are read from `getEmbeddingDim()` at schema-init time, which is why changing the embedding model requires a DB reset. `config` and `utils` are used by almost every pipeline and are drawn separately below so the main map keeps its control-flow shape.

## Cross-cutting dependencies

```mermaid
flowchart LR
  config["config/ (RagConfig)"]
  utils["utils/ (log + dir-guard)"]
  config --> indexing
  config --> search
  config --> wiki
  config --> conv["conversation/"]
  utils --> cli["cli/"]
  utils --> tools["tools/"]
  utils --> indexing
  utils --> server["server/"]
```

These two modules are used transitively by every pipeline. Drawing each "used by" edge on the main System Map would obscure the control-flow shape, so they live here instead. `config` is read at CLI / server startup and passed into every orchestrator; `utils` (`log`, `checkIndexDir`) is imported wherever a module needs to write a progress line or guard against running inside a dangerous directory.

## Modules

| Module | Files | Exports | Fan-in | Fan-out | Entry file |
|--------|-------|---------|--------|---------|------------|
| [db](modules/db/index.md) | 10 | 56 | 15 | 2 | `src/db/index.ts` |
| [wiki](modules/wiki.md) | 8 | 32 | 2 | 2 | `src/wiki/index.ts` |
| [commands](modules/commands.md) | 19 | 13 | 1 | 10 | — |
| [search](modules/search.md) | 4 | 16 | 5 | 4 | — |
| [indexing](modules/indexing.md) | 4 | 7 | 9 | 4 | — |
| [cli](modules/cli.md) | 3 | 14 | 3 | 3 | `src/cli/index.ts` |
| [tools](modules/tools.md) | 12 | 5 | 1 | 9 | `src/tools/index.ts` |
| [conversation](modules/conversation.md) | 2 | 5 | 4 | 2 | — |
| [utils](modules/utils.md) | 2 | 3 | 8 | 0 | — |
| [embeddings](modules/embeddings.md) | 1 | 8 | 17 | 0 | — |
| [config](modules/config.md) | 1 | 1 | 10 | 2 | `src/config/index.ts` |
| [graph](modules/graph.md) | 1 | 2 | 8 | 1 | — |
| [tests](modules/tests.md) | 1 | 3 | 11 | 0 | — |

## Hubs

High-fan-in files — anything that changes here ripples widely.

| File | Fan-in | Fan-out | What it exposes |
|------|--------|---------|-----------------|
| `src/embeddings/embed.ts` | 75 | 0 | `embed`, `embedBatch`, `embedBatchMerged`, `configureEmbedder`, `getEmbeddingDim` |
| `tests/helpers.ts` | 65 | 0 | `createTempDir`, `writeFixture`, `cleanupTempDir` — fixture scaffolding |
| `src/db/index.ts` | 55 | 9 | `RagDB` facade + every row-shape type |
| `src/wiki/types.ts` | 50 | 1 | Shared shapes for the wiki pipeline |
| `src/config/index.ts` | 40 | 4 | `loadConfig`, `applyEmbeddingConfig`, `RagConfig` |
| `src/utils/log.ts` | 27 | 0 | `log` (stderr / LEVEL-gated) + `cli` (stdout) |
| `src/search/hybrid.ts` | 18 | 3 | `search`, `searchChunks`, `mergeHybridScores` |
| `src/graph/resolver.ts` | 17 | 1 | `resolveImports`, `resolveImportsForFile`, `generateProjectMap` |
| `src/indexing/chunker.ts` | 17 | 1 | `chunkText` — bun-chunk wrapper |
| `src/indexing/indexer.ts` | 17 | 10 | `indexDirectory` — the write-path orchestrator |
| `src/tools/index.ts` | 12 | 14 | `resolveProject`, `registerAllTools` |
| `src/search/benchmark.ts` | 12 | 3 | `runBenchmark`, `loadBenchmarkQueries`, `formatBenchmarkReport` |
| `src/conversation/parser.ts` | 11 | 0 | `readJSONL`, `parseTurns`, `buildTurnText` |
| `src/search/eval.ts` | 8 | 3 | `runEval`, `loadEvalTasks`, `formatEvalReport` |
| `src/cli/progress.ts` | 7 | 1 | `cliProgress`, `createQuietProgress` |
| `src/indexing/parse.ts` | 7 | 0 | `parseFile` |
| `src/cli/setup.ts` | 6 | 1 | `runSetup` + `ensure*` install helpers |
| `src/indexing/watcher.ts` | 2 | 4 | `startWatcher` — the filesystem-watch bridge |

`embed.ts` at fan-in 75 is the single architectural centre: every indexing, search, conversation, wiki, benchmark, and test path reaches it, directly or transitively. That's why `configureEmbedder` is called at app startup (via `applyEmbeddingConfig`) rather than per-call — the singleton would otherwise lose per-project overrides.

## Cross-Cutting Symbols

Symbols referenced from three or more modules. These are the project's shared vocabulary.

| Symbol | Type | Defined in | Used in N modules |
|--------|------|------------|-------------------|
| `RagDB` | class | `src/db/index.ts` | 11+ |
| `cleanupTempDir` | function | `tests/helpers.ts` | 11 |
| `createTempDir` | function | `tests/helpers.ts` | 11 |
| `embed` | function | `src/embeddings/embed.ts` | 10+ |
| `getEmbedder` | function | `src/embeddings/embed.ts` | 9 |
| `writeFixture` | function | `tests/helpers.ts` | 8 |
| `embedBatch` | function | `src/embeddings/embed.ts` | 4 |
| `ClassifiedInventory` | interface | `src/wiki/types.ts` | 2 |
| `RagConfig` | type | `src/config/index.ts` | 3 |
| `formatBenchmarkReport` | function | `src/search/benchmark.ts` | 3 |
| `loadBenchmarkQueries` | function | `src/search/benchmark.ts` | 3 |
| `parseFile` | function | `src/indexing/parse.ts` | 2 |
| `runBenchmark` | function | `src/search/benchmark.ts` | 3 |

## Design Decisions

- **SQLite + `sqlite-vec` + FTS5, not a server DB.** mimirs is per-project and runs on the user's machine. Vector + lexical search live in the same file; no network hop. On macOS the constructor points `bun:sqlite` at Homebrew's build because Apple's bundled SQLite can't load extensions.
- **Hybrid ranking with a blend, not pure vector.** `search/hybrid.ts` computes `0.7 × vectorScore + 0.3 × BM25Score` so exact-name matches (`RagDB`, `embedBatch`) don't get buried under semantic drift. The ratio is tunable via `config.hybridWeight`.
- **Two-pass graph resolution.** The indexer writes imports with `resolved_file_id = NULL` and a second pass patches them after every file is on disk in the DB. This removes the file-ordering dependency that a single-pass resolver would require.
- **Conversation indexing is tail-based, not one-shot.** `startConversationTail` watches the JSONL file and indexes appended turns; `readOffset` is a byte offset so repeat passes are cheap. Claude Code's own `Read` / `Glob` / `Write` / `Edit` tool-results are skipped because the code index already has that content — only the tool name survives.
- **Wiki generation is data-driven, not template-driven.** Page-level "required sections" were replaced with a section library where each snippet carries an `applies` predicate over the prefetched cache. Aggregate pages (like this one) use full exemplars with `<!-- adapt -->` markers; module pages compose from matched snippets. The agent decides which sections fit, the pipeline supplies signals.

## See also

- [Data Flows](data-flows.md)
- [Getting Started](guides/getting-started.md)
- [Conventions](guides/conventions.md)
- [Testing](guides/testing.md)
- [Index](index.md)
