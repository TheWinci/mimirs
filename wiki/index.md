# mimirs

Persistent project memory for AI coding agents — local semantic code search, dependency graphs, and conversation history over SQLite + `sqlite-vec` + FTS5.

This wiki is auto-generated from the source and index. Start with [Getting Started](guides/getting-started.md) for setup, or [Architecture](architecture.md) for the system map.

## Quick Links

- [Getting Started](guides/getting-started.md) — install, init, first index, first search
- [Architecture](architecture.md) — high-level system design
- [db](modules/db/index.md) — `RagDB` facade, the single persistence boundary
- [search](modules/search.md) — hybrid ranking (vec + BM25 + path / graph boosts)
- [wiki](modules/wiki/index.md) — this wiki's own generator

## Architecture and Design

| Page | Description |
|------|-------------|
| [Architecture](architecture.md) | System map, hubs, cross-cutting symbols, design decisions |
| [Data Flows](data-flows.md) | Indexing, hybrid search, conversation tail, wiki generation |

## Modules

| Module | Description |
|--------|-------------|
| [db](modules/db/index.md) | `RagDB` facade over SQLite + `sqlite-vec` + FTS5 |
| [embeddings](modules/embeddings.md) | MiniLM-L6-v2 (384-dim) singleton — `embed`, `embedBatch`, `embedBatchMerged` |
| [indexing](modules/indexing.md) | Walk + parse + AST-chunk + embed + upsert; watcher for incremental reindex |
| [search](modules/search.md) | Hybrid ranking, benchmark, eval, symbol expansion |
| [graph](modules/graph.md) | Two-pass import resolver; powers `depends_on`, `project_map`, the graph boost |
| [conversation](modules/conversation.md) | Tails Claude Code JSONL transcripts; byte-offset resume |
| [wiki](modules/wiki/index.md) | 4-phase generator: discovery → categorization → page-tree → prefetch |
| [tools](modules/tools.md) | MCP tool registration — the surface editors call |
| [commands](modules/commands.md) | 19 CLI subcommand handlers behind `mimirs <cmd>` |
| [cli](modules/cli.md) | Argv dispatcher + setup + progress |
| [config](modules/config.md) | `RagConfig` schema + self-healing loader |
| [utils](modules/utils.md) | `log` / `cli` output + directory guard |
| [tests](modules/tests.md) | Fixture scaffolding shared across test suites |

## db sub-pages

The `db` facade is split across several files; each has its own page:

| Page | Description |
|------|-------------|
| [db/types](modules/db/types.md) | Row shapes and TypeScript interfaces for DB rows |
| [db/files](modules/db/files.md) | File + chunk upsert / query surface |
| [db/graph](modules/db/graph.md) | Import and symbol-graph persistence |
| [db/conversation](modules/db/conversation.md) | Session, turn, and turn-chunk storage |
| [db/git-history](modules/db/git-history.md) | Commit history index and FTS |

## wiki sub-pages

The `wiki` generator is similarly decomposed:

| Page | Description |
|------|-------------|
| [wiki/types](modules/wiki/types.md) | Plan, page, and manifest types |
| [wiki/discovery](modules/wiki/discovery.md) | Phase 1 — module discovery and entry detection |
| [wiki/section-selector](modules/wiki/section-selector.md) | Picks the section library entries for each page |
| [wiki/staleness](modules/wiki/staleness.md) | Incremental regeneration via git diff against `lastGitRef` |

## Guides

| Guide | Description |
|-------|-------------|
| [Getting Started](guides/getting-started.md) | Install, init, first-run commands, known issues |
| [Conventions](guides/conventions.md) | Naming, file organization, error handling, bun-only tooling |
| [Testing](guides/testing.md) | How to run and structure tests; temp-dir fixture pattern |

---

*Auto-generated wiki. Do not edit pages directly — change `src/wiki/` and regenerate.*
