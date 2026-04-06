# local-rag Wiki

Persistent project memory for AI coding agents. Semantic search, code intelligence, and conversation history — all local, all SQLite, no API keys.

## Architecture
- [Architecture Overview](architecture.md) — high-level structure and design decisions
- [Data Flow](data-flow.md) — how indexing, search, and conversation pipelines work
- [API Surface](api-surface.md) — all 21 MCP tools, 18 CLI commands, and configuration options

## Modules
- [CLI](modules/cli/index.md) — command-line interface with 18 subcommands
- [Config](modules/config/index.md) — Zod-validated configuration loading and defaults
- [Conversation](modules/conversation/index.md) — Claude Code JSONL session parsing and indexing
- [DB](modules/db/index.md) — SQLite persistence layer with sqlite-vec and FTS5
- [Embeddings](modules/embeddings/index.md) — local transformer embeddings via ONNX
- [Graph](modules/graph/index.md) — import resolution and dependency graph generation
- [Indexing](modules/indexing/index.md) — file chunking, embedding, and incremental updates
- [Search](modules/search/index.md) — hybrid vector + BM25 search with score adjustments
- [Server](modules/server/index.md) — MCP server over stdio with file watching
- [Tools](modules/tools/index.md) — 21 MCP tool definitions
- [Utils](modules/utils/index.md) — logging and directory validation

## Key Entities
- [RagDB](entities/rag-db.md) — central database facade class
- [Hybrid Search](entities/hybrid-search.md) — search and searchChunks functions
- [Chunk](entities/chunk.md) — the fundamental unit of indexed content
- [RagConfig](entities/rag-config.md) — configuration type and defaults

## Guides
- [Getting Started](guides/getting-started.md) — prerequisites, setup, and project structure
- [Conventions](guides/conventions.md) — naming, error handling, and module patterns
- [Testing](guides/testing.md) — test structure, runner, and known issues

## Reference
- [Glossary](glossary.md) — domain terms and project-specific jargon
