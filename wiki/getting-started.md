# Getting started

> [Architecture](architecture.md)
>
> Generated from `79e963f` · 2026-04-26

## What this is

Mimirs is a local-first, persistent project memory layer for AI coding agents. It runs as an MCP server inside your project directory, indexing your code with AST-aware chunking (tree-sitter grammars across 24 languages), embedding each chunk in-process using all-MiniLM-L6-v2 via Transformers.js and ONNX, and storing everything in a single SQLite file under `.mimirs/`. When your agent issues a `search` or `read_relevant` call, mimirs blends vector similarity and BM25, boosts results by dependency-graph centrality, and returns exact line ranges — not file paths. It also tails Claude Code's conversation transcripts in real time, so checkpoints and past decisions remain searchable across sessions. No API keys, no cloud, no daemon: Bun and SQLite are the only runtime requirements. On one real codebase, switching from raw grep-and-read to mimirs cut prompt token usage from 380K to 91K tokens per query — a 76% reduction.

## Installation

Mimirs is distributed on npm and runs with Bun. Before installing, make sure you have a SQLite build that supports extensions — macOS ships a sandboxed SQLite that does not:

```bash
brew install sqlite          # macOS only; Linux distros typically ship a full build
```

Then run the one-command setup from your project root:

```bash
bunx mimirs init --ide claude   # or: cursor, windsurf, copilot, jetbrains, all
```

This single command creates the MCP server configuration, injects editor rules and tool descriptions, writes `.mimirs/config.json` with defaults, and adds `.mimirs/` to your `.gitignore`. If you work across multiple editors, pass `--ide all` to configure every supported client at once. No additional build step is needed — `bunx` resolves and runs the package directly.

The runtime dependencies that matter most are `@winci/bun-chunk` (tree-sitter AST parsing), `@huggingface/transformers` (in-process embedding), and `sqlite-vec` (vector search extension). All are declared in the project's package manifest and installed automatically.

## First run

After `init` completes, open your editor. The MCP server starts automatically when the editor connects. To verify the index is live, run the optional demo from your terminal:

```bash
bunx mimirs demo
```

The demo indexes a small synthetic codebase, runs a sample query, and prints ranked results with line ranges — you should see output like:

```
[1] src/example.ts:12-34  (score: 0.91)
    function parseConfig(path: string): Config { … }
```

If `demo` succeeds, the server is working correctly. From that point on, your agent can call `search`, `read_relevant`, `project_map`, `search_conversation`, and `annotate` through the MCP protocol. The file watcher picks up changes with a 2-second debounce and re-indexes modified files automatically — you do not need to reindex manually during normal development.

If the server fails to start, check `.mimirs/status` for the last error written at startup. Permanent init errors (filesystem permissions, missing native libraries) are recorded there. Transient errors such as a locked database are not cached and will clear on the next connection attempt.

## Where to look next

For the overall system design — how the indexing pipeline, search runtime, dependency graph, and MCP server wire together — read the [Architecture](architecture.md) page. If you need to tune embedding behavior or change the model, the [Config & Embeddings](communities/config-embeddings.md) community page is the definitive reference: it covers how `loadConfig` writes defaults on first run (so the file on disk is always the authoritative source), how the embedding singleton is initialized, and which constants control batch size and dimensions. For a tour of every available MCP tool and CLI subcommand, see [CLI Commands](communities/cli-commands.md) and [MCP Tool Handlers](communities/mcp-tools.md). The [Data flows](data-flows.md) page traces how a query or an indexing event moves through the system end-to-end.

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
- [Import Graph & File Watcher](communities/graph-watcher.md)
- [Indexing Pipeline](communities/indexing-pipeline.md)
- [MCP Tool Handlers](communities/mcp-tools.md)
- [Search MCP Tool](communities/search-tool.md)
- [Search Runtime](communities/search-runtime.md)
- [Wiki Orchestrator & MCP Tools](communities/wiki-orchestrator.md)
- [Wiki Pipeline — Types & Internals](communities/wiki-pipeline-internals.md)
