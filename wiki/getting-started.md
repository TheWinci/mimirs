# Getting started

> [Architecture](architecture.md)
>
> Generated from `6a2d580` · 2026-04-26

## What this is

Mimirs is a local-first persistent memory layer for AI coding agents. It runs as an MCP server inside your project directory, indexing source files with AST-aware chunking (tree-sitter grammars across 24 languages via `@winci/bun-chunk`), embedding each chunk in-process with all-MiniLM-L6-v2 through `@huggingface/transformers` and ONNX, and storing everything in a single SQLite file under `.mimirs/`. When the agent issues a `search` or `read_relevant` call, mimirs blends vector similarity with BM25, boosts results by dependency-graph centrality and path heuristics, and returns ranked chunks with exact line ranges (`path:start-end`) instead of whole files. It also tails Claude Code's JSONL transcripts in real time so checkpoints and past discussions remain searchable across sessions. There are no API keys, no cloud, no daemon, and no Docker — Bun and SQLite are the only runtime requirements. On one real codebase the README cites a drop from roughly 380K tokens and 12 seconds per prompt to 91K tokens and 3 seconds — a 76% reduction — once retrieval moved from raw grep-and-read to mimirs.

## Installation

Mimirs is published on npm as `mimirs` and runs on Bun. The single hard prerequisite is a SQLite build that loads extensions: macOS ships a sandboxed SQLite that does not, so on macOS install one first with Homebrew. On Linux the distro-packaged SQLite typically already supports extensions and no extra step is needed.

```bash
brew install sqlite          # macOS only
```

From the project you want indexed, run the setup command. It is idempotent and writes only what is missing, so re-running it is safe.

```bash
bunx mimirs init --ide claude   # or: cursor, windsurf, copilot, jetbrains, all
```

`init` is implemented in `src/cli/setup.ts` and chains four steps under `runSetup`: it calls `loadConfig` from `src/config/index.ts` to create `.mimirs/config.json` with defaults if absent, injects per-IDE rule files (the `INSTRUCTIONS_BLOCK` describing every mimirs MCP tool goes into `CLAUDE.md`, and `MDC_BLOCK` / `WINDSURF_BLOCK` / `MARKDOWN_BLOCK` cover Cursor, Windsurf, Junie and Copilot), upserts the `mcpServers.mimirs` entry into each IDE's MCP config JSON, and finally appends `.mimirs/` to `.gitignore`. Pass `--ide all` to target every editor in `KNOWN_IDES = ["claude", "cursor", "windsurf", "copilot", "jetbrains"]` in one run; unknown names are reported but do not abort the run. The MCP entry written into config files is `{ command: "bunx", args: ["mimirs@latest", "serve"], env: { RAG_PROJECT_DIR: <abs> } }`, so the server is launched on demand by your editor — there is nothing to start manually.

There is no separate build step. The package ships TypeScript sources and is executed directly under Bun (the `bin` entry is `src/main.ts`). Project commands documented in the package manifest use `bun run`: `bun run server` to start the MCP server, `bun run cli` for one-off CLI invocations, `bun run test` and `bun run bench` for tests and benchmarks. The runtime dependencies that matter most are `@winci/bun-chunk` for AST chunking, `@huggingface/transformers` for embeddings, `sqlite-vec` for vector search, `graphology` plus `graphology-communities-louvain` for the dependency graph and the wiki's community detection, and `@modelcontextprotocol/sdk` for the MCP transport — all installed automatically.

## First run

Once `init` reports its actions, open your editor. The MCP server is started by the editor when it connects to the configured `mimirs` server entry, so there is nothing to launch by hand. To confirm the install end-to-end without involving the agent, run the bundled demo from the same project root:

```bash
bunx mimirs demo
```

The demo command lives in `src/cli/commands/demo.ts` and exercises the full pipeline: it constructs a `RagDB` against the current directory, calls `loadConfig`, indexes the project with AST-aware chunking, runs a sample query through the hybrid search path, and prints ranked chunks with their `path:start-end` line ranges. If you see ranked results printed back, indexing, embedding, and search are all working. From that point on your agent can call `search`, `read_relevant`, `project_map`, `search_conversation`, `annotate`, and the rest over MCP — the file watcher debounces edits and re-indexes automatically, so manual reindexing is not part of the normal loop.

If the server fails to start, the most useful first step is `bunx mimirs doctor`, the dedicated diagnostics command added in 1.1 (see CHANGELOG). Permanent initialization errors — filesystem permission failures or missing native libraries — are recorded once at startup in `src/server/index.ts` so the next tool call returns the same message instead of retrying. Transient errors such as `database is locked` are deliberately not cached, so they clear on the next call. Signal handlers (`SIGINT`, `SIGTERM`, stdin close, stdin error) all funnel through the same cleanup path so a closed editor window writes a clean shutdown status rather than leaving stale state behind.

## Where to look next

For the system as a whole — how the indexing pipeline, the search runtime, the dependency graph, and the MCP server fit together — read [Architecture](architecture.md). The single most important community to read before touching internals is [Config & Embeddings](communities/config-embeddings.md): it documents the embedding singleton, batch embedding, and how the on-disk YAML config overrides model and dimension defaults — that is the reference before anything that calls `embed()` or `loadConfig`. For the per-editor mechanics of `init`, including idempotency, marker handling, and the dual Windsurf MCP locations, see [CLI Setup & IDE Integration](communities/cli-setup.md). For a tour of every CLI subcommand and every MCP tool the agent can call, see [CLI Commands](communities/cli-commands.md) and [MCP Tool Handlers](communities/mcp-tools.md). [Data flows](data-flows.md) traces how a single query or a single indexing event moves through the system end-to-end.

## See also

- [Architecture](architecture.md)
- [CLI Commands](communities/cli-commands.md)
- [CLI Entry & Core Utilities](communities/cli-entry-core.md)
- [CLI Setup & IDE Integration](communities/cli-setup.md)
- [Community Detection & Discovery](communities/community-detection.md)
- [Config & Embeddings](communities/config-embeddings.md)
- [Conversation Indexer & MCP Server](communities/conversation-server.md)
- [Data flows](data-flows.md)
- [Database Layer](communities/db-layer.md)
- [Git History Indexer & CLI Progress](communities/git-indexer-progress.md)
- [Indexing runtime](communities/indexing-runtime.md)
- [MCP Tool Handlers](communities/mcp-tools.md)
- [Search MCP Tool](communities/search-tool.md)
- [Search Runtime](communities/search-runtime.md)
- [Wiki orchestration](communities/wiki-orchestration.md)
- [Wiki Pipeline — Types & Internals](communities/wiki-pipeline-internals.md)
