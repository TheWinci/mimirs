# Getting Started

## Prerequisites

- **Bun runtime** — Install from [bun.sh](https://bun.sh)
- **Homebrew SQLite** (macOS only) — Apple's bundled SQLite does not support extensions. Install via Homebrew:
  ```sh
  brew install sqlite
  ```

## Setup

Run the init command for your IDE:

```sh
bunx @winci/local-rag init --ide claude
```

Supported `--ide` values: `claude`, `cursor`, `windsurf`, `copilot`, `jetbrains`, `all`.

This creates:

| File | Purpose |
|---|---|
| `.mcp.json` | MCP server configuration for your IDE |
| `CLAUDE.md` (or IDE equivalent) | Codebase instructions referencing local-rag tools |
| `.rag/config.json` | Project-level RAG configuration ([RagConfig](../glossary.md#ragconfig)) |
| `.gitignore` entry | Excludes `.rag/` data directory from version control |

After init completes, the first index runs interactively — it walks your project, chunks source files, generates embeddings, and populates the SQLite database.

## Project Structure

```
src/
  cli/           # CLI entry point and commands
  config/        # Zod-validated RagConfig loading and defaults
  conversation/  # Conversation history storage and search
  db/            # RagDB facade and SQLite delegate modules
  embeddings/    # 384-dim vector generation
  graph/         # Dependency graph (import/export edges)
  indexing/      # File walking, chunking, and upsert pipeline
  search/        # Hybrid search (vector + BM25)
  server/        # MCP server and transport
  tools/         # MCP tool definitions and handlers
  utils/         # Shared helpers
tests/           # Mirrors src/ structure
benchmarks/      # Performance benchmarks
docs/            # Documentation source
skills/          # Claude Code skill definitions
hooks/           # Git and IDE hooks
```

## Key Concepts

| Concept | Description |
|---|---|
| **Chunk** | A semantically meaningful fragment of a source file — a function, class, or markdown section. See [glossary](../glossary.md#chunk). |
| **Embedding** | A 384-dimensional `Float32Array` vector that captures the semantic meaning of a chunk. See [glossary](../glossary.md#embedding). |
| **Hybrid search** | Combines vector similarity with [BM25](../glossary.md#bm25) keyword matching for better recall and precision. |
| **Dependency graph** | Tracks import/export edges between files, powering the `depends_on`, `depended_on_by`, and `project_map` tools. |

## Next Steps

Once the initial index completes, your IDE can call local-rag's MCP tools (`search`, `read_relevant`, `project_map`, etc.) to navigate and understand your codebase.

## See Also

- [Conventions](conventions.md) — coding standards and module patterns
- [Testing](testing.md) — running and writing tests
- [Architecture](../architecture.md) — system design overview
- [Glossary](../glossary.md) — terminology reference
