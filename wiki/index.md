# mimirs

Persistent project memory for AI coding agents — local semantic code search, dependency graphs, and conversation history over SQLite + `sqlite-vec` + FTS5.

## Quick Links

- [Getting Started](guides/getting-started.md) — setup and first run
- [Architecture](architecture.md) — high-level system design
- [db](modules/db/index.md) — `RagDB` facade, the single persistence boundary
- [search](modules/search.md) — hybrid ranking (vec + BM25 + path / graph boosts)
- [wiki](modules/wiki.md) — this wiki's own generator

## Architecture & Design

| Page | Description |
|------|-------------|
| [Architecture](architecture.md) | system map, hubs, cross-cutting symbols, design decisions |
| [Data Flows](data-flows.md) | indexing, hybrid search, conversation tail, wiki generation |

## Modules

| Module | Description |
|--------|-------------|
| [db](modules/db/index.md) | `RagDB` facade over SQLite + `sqlite-vec` + FTS5 |
| [embeddings](modules/embeddings.md) | MiniLM-L6-v2 (384-dim) singleton — `embed`, `embedBatch`, `embedBatchMerged` |
| [indexing](modules/indexing.md) | Walk + parse + AST-chunk + embed + upsert; watcher for incremental reindex |
| [search](modules/search.md) | Hybrid ranking, benchmark, eval, symbol expansion |
| [graph](modules/graph.md) | Two-pass import resolver; powers `depends_on`, `project_map`, graph boost |
| [conversation](modules/conversation.md) | Tails Claude Code JSONL transcripts; byte-offset resume |
| [wiki](modules/wiki.md) | 4-phase generator: discovery → categorization → page-tree → prefetch |
| [tools](modules/tools.md) | MCP tool registration — the surface editors call |
| [commands](modules/commands.md) | 19 CLI subcommand handlers behind `mimirs <cmd>` |
| [cli](modules/cli.md) | Argv dispatcher + setup + progress |
| [config](modules/config.md) | `RagConfig` schema + self-healing loader |
| [utils](modules/utils.md) | `log` / `cli` output + directory guard |
| [tests](modules/tests.md) | Fixture scaffolding shared across test suites |

## Guides

| Guide | Description |
|-------|-------------|
| [Getting Started](guides/getting-started.md) | setup, install, first-run commands |
| [Conventions](guides/conventions.md) | naming, file organization, error handling, patterns |
| [Testing](guides/testing.md) | how to run and structure tests |

---

*Generated from 160 indexed files (1743 chunks) on 2026-04-17.*
