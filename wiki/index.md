# mimirs

Local-first MCP server that gives AI coding assistants a persistent, searchable memory of your codebase: AST-aware chunking, hybrid vector+BM25 retrieval, and a wiki generation pipeline.

## Quick Links

- [Getting Started](getting-started.md) — install, first run, project layout
- [Architecture](architecture.md) — system map, hubs, design decisions
- [Data Flows](data-flows.md) — search, indexing, and wiki generation end-to-end

## Architecture & Design

| Page | Description |
|------|-------------|
| [Architecture](architecture.md) | System map, load-bearing hubs, entry points, and cross-cutting dependencies |
| [Data Flows](data-flows.md) | Semantic search, indexing batch+incremental, and wiki generation flows |

## Communities

| Page | Description |
|------|-------------|
| [CLI Commands](communities/cli-commands.md) | All 19 CLI subcommand handlers and the argument dispatch pattern |
| [CLI Entry & Core Utilities](communities/cli-entry-core.md) | Process entry point, top-level types, and the shared log/cli sinks |
| [CLI Setup & IDE Integration](communities/cli-setup.md) | First-run setup, MCP config writing for Claude/Cursor/Windsurf/JetBrains/Copilot |
| [Community Detection & Discovery](communities/community-detection.md) | Louvain clustering, dispatch-directory seeding, DiscoveryResult assembly |
| [Config & Embeddings](communities/config-embeddings.md) | Embedding singleton, model config, batch merging |
| [Conversation Indexer & MCP Server](communities/conversation-server.md) | JSONL conversation parsing, session indexing, and MCP server bootstrap |
| [Database Layer](communities/db-layer.md) | SQLite persistence: files, chunks, annotations, checkpoints, git history, graph |
| [Git History Indexer & CLI Progress](communities/git-indexer-progress.md) | Git commit ingestion and CLI progress reporter |
| [Indexing runtime](communities/indexing-runtime.md) | Walk, parse, chunk, embed, watch, and resolve the import graph |
| [MCP Tool Handlers](communities/mcp-tools.md) | Tool registration layer wiring domain groups to the MCP server |
| [Search MCP Tool](communities/search-tool.md) | `search`, `read_relevant`, `search_symbols`, `write_relevant` MCP adapters |
| [Search Runtime](communities/search-runtime.md) | Hybrid vector+FTS engine, ranking boosts, benchmark/eval harness |
| [Wiki orchestration](communities/wiki-orchestration.md) | `generate_wiki` MCP surface, lint-page validator, section catalog, update log |
| [Wiki Pipeline — Types & Internals](communities/wiki-pipeline-internals.md) | Data model, PageRank, staleness detection, and page assembly for wiki gen |

## Guides

| Guide | Description |
|-------|-------------|
| [Getting Started](getting-started.md) | Install, first run, project layout, key concepts |

---

*Generated from 25 pages across 14 communities.*
