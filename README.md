# local-rag

Persistent project memory for AI coding agents. One command to set up, nothing to maintain.

[![npm](https://img.shields.io/npm/v/@winci/local-rag)](https://www.npmjs.com/package/@winci/local-rag)
[![license](https://img.shields.io/npm/l/@winci/local-rag)](LICENSE)

Your agent starts every session blind — guessing filenames, grepping for keywords, burning context on irrelevant files, and forgetting everything you discussed yesterday.

On a real project, that costs **380K tokens per prompt and 12-second response times**.

After indexing with local-rag: **91K tokens, 3 seconds**. A 76% reduction — depending on your model and usage, that's hundreds to thousands in monthly API savings.

No API keys. No cloud. No Docker. Just [bun](https://bun.sh/docs/installation) and SQLite.

### Works with

Claude Code &nbsp;·&nbsp; Cursor &nbsp;·&nbsp; Windsurf &nbsp;·&nbsp; JetBrains (Junie) &nbsp;·&nbsp; GitHub Copilot &nbsp;·&nbsp; any MCP client

## Search quality

100% recall. Benchmarked on four real codebases — including Kubernetes at 8,691 files — with known expected results per query. Full methodology in [BENCHMARKS.md](BENCHMARKS.md).

| Codebase | Language | Files | Queries | Recall@10 | MRR | Zero-miss |
|---|---|---|---|---|---|---|
| local-rag | TypeScript | 97 | 20 | 100.0% | 0.651 | 0.0% |
| Express.js | JavaScript | 161 | 15 | 100.0% | 0.922 | 0.0% |
| Excalidraw | TypeScript | 676 | 20 | 100.0% | 0.366 | 0.0% |
| Kubernetes | Go | 8,691 | 20 | 100.0%* | 0.496 | 0.0%* |

\*With config tuning. At default top-10, Recall is 80%. See [BENCHMARKS.md](BENCHMARKS.md) for details.

## How it compares

|  | local-rag | No tool (grep + Read) | Context stuffing | Cloud RAG services |
|---|---|---|---|---|
| Setup | One command | Nothing | Nothing | API keys, accounts |
| Token cost | ~91K/prompt | ~380K/prompt | Entire codebase | Varies |
| Search quality | 100% Recall@10 | Depends on keywords | N/A (everything loaded) | Varies |
| Code understanding | AST-aware (24 langs) | Line-level | None | Usually line-level |
| Cross-session memory | Conversations + checkpoints | None | None | Some |
| Privacy | Fully local | Local | Local | Data leaves your machine |
| Price | Free | Free | High token bills | $10-50/mo + tokens |

## What it gives your agent

**Find code by meaning, not filename.**
"Where do we handle authentication errors?" → local-rag finds `middleware/session-guard.ts`. Hybrid vector + BM25 search, boosted by dependency graph centrality.

**Remember past sessions.**
Conversation transcripts are indexed in real time. Three days later, your agent can search for "why did we switch to JWT?" and get the exact discussion.

**Know what changed since last time.**
`git_context` shows uncommitted changes and recent commits in one call, so agents don't propose edits that conflict with in-progress work.

**Leave notes for future sessions.**
`annotate` attaches persistent caveats to files or symbols — "known race condition", "blocked on auth rewrite" — that surface automatically in search results.

**Mark decisions, not just code.**
Checkpoints capture milestones, direction changes, and blockers. Searchable across sessions so context doesn't evaporate.

**Understand codebase structure.**
Dependency graphs, reverse-dependency lookups, and `find_usages` show the blast radius before any refactor.

**Generate a project wiki.**
`generate_wiki` produces a structured, cross-linked markdown wiki — architecture docs, module pages, entity pages, guides, and Mermaid diagrams — all built from the semantic index.

**Expose documentation gaps.**
Analytics log every query locally — nothing leaves your machine. Zero-result and low-relevance queries reveal what's missing from your docs.

## Quick start

### 1. Install SQLite (macOS)

Apple's bundled SQLite doesn't support extensions:

```bash
brew install sqlite
```

### 2. Set up your editor

```bash
bunx @winci/local-rag init --ide claude   # or: cursor, windsurf, copilot, jetbrains, all
```

This creates the MCP server config, editor rules, `.rag/config.json`, and `.gitignore` entry. Run with `--ide all` to set up every supported editor at once.

### 3. Try the demo (optional)

```bash
bunx @winci/local-rag demo
```

### Claude Code plugin

For deeper integration, local-rag is also available as a Claude Code plugin. In a Claude Code session:

```
/plugin marketplace add https://github.com/TheWinci/local-rag.git
/plugin install local-rag
```

The plugin adds **SessionStart** (context summary), **PostToolUse** (auto-reindex on edit), and **SessionEnd** (auto-checkpoint) hooks. No `CLAUDE.md` instructions needed — the plugin's built-in skill handles tool usage.

## How it works

1. **Parse & chunk** — Splits content using type-matched strategies: function/class boundaries for code (via tree-sitter across 24 languages), headings for markdown, top-level keys for YAML/JSON. Chunks that exceed the embedding model's token limit are windowed and merged.

2. **Embed** — Each chunk becomes a 384-dimensional vector using all-MiniLM-L6-v2 (in-process via Transformers.js + ONNX, no API calls). Vectors are stored in sqlite-vec.

3. **Build dependency graph** — Import specifiers and exported symbols are captured during AST chunking, then resolved to build a file-level dependency graph.

4. **Hybrid search** — Queries run vector similarity and BM25 in parallel, blended by configurable weight. Results are boosted by dependency graph centrality and path heuristics. `read_relevant` returns individual chunks with entity names and exact line ranges (`path:start-end`).

5. **Watch & re-index** — File changes are detected with a 2-second debounce. Changed files are re-indexed; deleted files are pruned.

6. **Conversation & checkpoints** — Tails Claude Code's JSONL transcripts in real time. Agents can create checkpoints at important moments for future sessions to search.

7. **Annotations** — Notes attached to files or symbols surface as `[NOTE]` blocks inline in `read_relevant` results.

8. **Analytics** — Every query is logged. Analytics surface zero-result queries, low-relevance queries, and period-over-period trends.

## Supported languages

AST-aware chunking via [bun-chunk](https://github.com/TheWinci/bun-chunk) with tree-sitter grammars:

TypeScript/JavaScript, Python, Go, Rust, Java, C, C++, C#, Ruby, PHP, Scala, Kotlin, Lua, Zig, Elixir, Haskell, OCaml, Dart, Bash/Zsh, TOML, YAML, HTML, CSS/SCSS/LESS

Also indexes: Markdown, JSON, XML, SQL, GraphQL, Protobuf, Terraform, Dockerfiles, Makefiles, and more. Files without a known extension fall back to paragraph splitting.

## Documentation

- [MCP tools, CLI & analytics](docs/tools.md)
- [Configuration & examples](docs/configuration.md)
- [Benchmarks](BENCHMARKS.md)

## Stack

| Layer | Choice |
|---|---|
| Runtime | Bun (built-in SQLite, fast TS) |
| AST chunking | [bun-chunk](https://github.com/TheWinci/bun-chunk) — tree-sitter grammars for 24 languages |
| Embeddings | Transformers.js + ONNX (in-process, no daemon) |
| Embedding model | all-MiniLM-L6-v2 (~23MB, 384 dimensions) — [configurable](docs/configuration.md) |
| Vector store | sqlite-vec (single `.db` file) |
| MCP | @modelcontextprotocol/sdk (stdio transport) |
| Plugin | Claude Code plugin with skills + hooks |

All data lives in `.rag/` inside your project — add it to `.gitignore`.