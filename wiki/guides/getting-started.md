# Getting Started

## Prerequisites

- **Bun runtime** -- Install from [bun.sh](https://bun.sh)
- **Homebrew SQLite** (macOS only) -- Apple's bundled SQLite does not support extensions. Install via Homebrew:
  ```sh
  brew install sqlite
  ```

## Setup

Run the init command for your IDE:

```sh
bunx mimirs init --ide claude
```

Supported `--ide` values: `claude`, `cursor`, `windsurf`, `copilot`, `jetbrains`, `all`.

This creates:

| File | Purpose |
|---|---|
| `.mcp.json` (or IDE equivalent) | MCP server configuration for your IDE |
| `CLAUDE.md` (or IDE equivalent) | Codebase instructions referencing mimirs tools |
| `.mimirs/config.json` | Project-level RAG configuration ([RagConfig](../entities/rag-config.md)) |
| `.gitignore` entry | Excludes `.mimirs/` data directory from version control |

After init completes, the first index runs interactively -- it walks your project, chunks source files, generates embeddings, and populates the SQLite database.

## MCP Server

Once initialized, the MCP server starts automatically when your IDE opens the project:

```json
{
  "mcpServers": {
    "mimirs": {
      "command": "bunx",
      "args": ["mimirs", "serve"]
    }
  }
}
```

The server indexes in the background, watches for file changes, and tails conversation history -- all without blocking tool calls.

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
| **Chunk** | A semantically meaningful fragment of a source file -- a function, class, or markdown section. See [Chunk entity](../entities/chunk.md). |
| **Embedding** | A 384-dimensional `Float32Array` vector that captures the semantic meaning of a chunk. See [glossary](../glossary.md#embedding). |
| **Hybrid search** | Combines vector similarity with [BM25](../glossary.md#bm25) keyword matching for better recall and precision. See [Hybrid Search entity](../entities/hybrid-search.md). |
| **Dependency graph** | Tracks import/export edges between files, powering the `depends_on`, `depended_on_by`, and `project_map` tools. |

## Troubleshooting

- **Server won't start**: Run `bunx mimirs doctor` to diagnose SQLite, embeddings, and config issues.
- **No search results**: Run `bunx mimirs status` to check if files are indexed. If not, run `bunx mimirs index`.
- **macOS crash on startup**: Ensure Homebrew SQLite is installed (`brew install sqlite`).

## Next Steps

Once the initial index completes, your IDE can call mimirs's MCP tools (`search`, `read_relevant`, `project_map`, etc.) to navigate and understand your codebase.

## See Also

- [Conventions](conventions.md) -- coding standards and module patterns
- [Testing](testing.md) -- running and writing tests
- [Architecture](../architecture.md) -- system design overview
- [API Surface](../api-surface.md) -- all tools and commands
- [Glossary](../glossary.md) -- terminology reference
