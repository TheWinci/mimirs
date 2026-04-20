# Getting Started

mimirs is a **persistent project memory for AI coding agents** — a local RAG index that embeds your project's files into SQLite (with `sqlite-vec` + FTS5), tails Claude Code conversation transcripts, and exposes everything through an MCP server so Claude Code, Cursor, Windsurf, JetBrains (Junie), or GitHub Copilot can query it. This page walks through the first-run path: install, init, index, serve. Everything here is local — no API keys, no network calls, no Docker.

## Prerequisites

- **Bun ≥ 1.0** — the project runs entirely on Bun's JS runtime, uses `bun:sqlite`, and ships a CLI at `src/main.ts` (no compile step). Install via `curl -fsSL https://bun.sh/install | bash`.
- **SQLite with extension support (macOS only)** — Apple's bundled SQLite rejects `LOAD EXTENSION`, which breaks `sqlite-vec`. Fix with `brew install sqlite`. On Linux the distro package already supports extensions; no action needed.
- **An MCP-capable editor** — Claude Code, Cursor, Windsurf, JetBrains (Junie), or GitHub Copilot. `mimirs init` emits the right config for each.

## Install

As a consumer, from any project directory:

```sh
bunx mimirs init --ide claude   # or: cursor, windsurf, copilot, jetbrains, all
```

`init` writes `.mimirs/config.json`, registers the MCP server in the editor's config, adds `.mimirs/` to `.gitignore`, and drops agent instructions so the model knows which tools to call.

From a fresh checkout of this repo:

```sh
bun install
```

## Run

Index the current directory (walk, chunk, embed, write):

```sh
bunx mimirs index
```

Start the MCP server over stdio (what the editor connects to):

```sh
bunx mimirs serve
```

Search from the CLI (handy for smoke-testing the index):

```sh
bunx mimirs search "hybrid scoring"
bunx mimirs read "how does the indexer resume"
```

Other first-run niceties — all real subcommands wired in `src/cli/index.ts`:

```sh
bunx mimirs demo                  # 4-step walkthrough: index, search, read_relevant, search_symbols
bunx mimirs doctor                # checks Bun + SQLite + extension load
bunx mimirs status                # prints totalFiles / totalChunks / dbSize
bunx mimirs map --focus src/db    # Mermaid dependency graph around a file
```

When developing mimirs itself, prefix with `bun run src/main.ts` instead of `bunx mimirs` — same commands, runs the local checkout.

## Test

Full suite (runs benchmarks too — slow):

```sh
bun run test
```

Scoped run (fast; this is what you want day-to-day):

```sh
bun test tests/search/hybrid-search.test.ts
bun test tests/indexing/indexer.test.ts
bun test tests/wiki/page-tree.test.ts
```

Type-check:

```sh
bun run tsc
```

## Project Layout

| Module | Purpose |
|--------|---------|
| [db](../modules/db/index.md) | `RagDB` facade over SQLite + `sqlite-vec` + FTS5 — the only place that opens `Database` |
| [embeddings](../modules/embeddings.md) | MiniLM-L6-v2 (384-dim) singleton; `embed`, `embedBatch`, `embedBatchMerged` |
| [indexing](../modules/indexing.md) | Walk + parse + AST-chunk + embed + upsert; watcher for incremental reindex |
| [search](../modules/search.md) | Hybrid ranking (vec + BM25 + path/filename/graph boosts) |
| [graph](../modules/graph.md) | Two-pass import resolver; powers `depends_on`, `project_map`, the graph boost |
| [conversation](../modules/conversation.md) | Tails Claude Code JSONL transcripts; byte-offset resume |
| [wiki](../modules/wiki/index.md) | 4-phase wiki generator: discovery → categorization → page-tree → prefetch |
| [tools](../modules/tools.md) | MCP tool registration — what editors call |
| [commands](../modules/commands.md) | 19 CLI subcommands behind `mimirs <cmd>` |
| [cli](../modules/cli.md) | `main.ts` → argv dispatcher + setup + progress |
| [config](../modules/config.md) | `RagConfig` schema, self-healing loader at `.mimirs/config.json` |
| [utils](../modules/utils.md) | `log` / `cli` output helpers + directory guard |
| [tests](../modules/tests.md) | Fixture scaffolding shared across test suites |

## Key Concepts

- **`RagDB` is the only persistence boundary.** Every other module (indexing, search, graph, conversation, wiki) holds a `RagDB` and calls methods on it — no raw `Database` handles escape `src/db/`. Defined in `src/db/index.ts`.
- **Hybrid search, not pure vector.** `search/hybrid.ts` blends `0.7 × vectorScore + 0.3 × BM25Score` so exact identifier matches (`RagDB`, `embedBatch`) don't get buried under semantic drift. Tunable via `config.hybridWeight`.
- **Two-pass graph resolution.** The indexer writes `file_imports` rows with `resolved_file_id = NULL`; a second pass in `src/graph/resolver.ts` patches them after every file is on disk. Removes the file-ordering dependency a single-pass resolver would need.
- **Tail-based conversation indexing.** The conversation tail watches Claude Code's JSONL, debounces, and resumes from a stored byte offset — appends are O(append-size), not O(history).
- **Wiki is generated, never hand-edited.** `wiki/` files are output of `generate_wiki`. To change wording, edit the section library or exemplars under `src/wiki/`.

## Known Issues

- **macOS stock SQLite fails silently on extension load.** The fix is `brew install sqlite`; `mimirs doctor` detects this case and prints the right remediation.
- **Changing `config.embedding.model` after indexing corrupts neighbours.** Vector column widths are sized from `getEmbeddingDim()` at schema init. Recovery is `mimirs cleanup` + re-index.
- **`DANGEROUS_DIRS` in `utils/dir-guard.ts` is POSIX-first.** The CLI refuses to index `/`, `$HOME`, `/tmp` and friends; Windows paths aren't in the list (mimirs is macOS/Linux-first).

## See also

- [Architecture](../architecture.md)
- [Data Flows](../data-flows.md)
- [Conventions](conventions.md)
- [Testing](testing.md)
- [Index](../index.md)
