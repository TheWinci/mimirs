<div align="center">
  <img src="mimirs-logo-2.png" alt="mimirs logo" width="200">
  <h1>MIMIRS</h1>
  <p><i>Named after <a href="https://en.wikipedia.org/wiki/M%C3%ADmir">Mímir</a>, the Norse god of wisdom and knowledge.</i></p>
  <p>Persistent project memory for AI coding agents. One command to set up, nothing to maintain.</p>
  <p>
    <a href="https://www.npmjs.com/package/mimirs"><img src="https://img.shields.io/npm/v/mimirs" alt="npm"></a>
    <a href="LICENSE"><img src="https://img.shields.io/npm/l/mimirs" alt="license"></a>
  </p>
</div>

Your agent starts every session blind — guessing filenames, grepping for keywords, burning context on irrelevant files, and forgetting everything you discussed yesterday.

On one real project, a typical prompt was burning **380K tokens and ~12 seconds end-to-end**.

After indexing with mimirs: **91K tokens, ~3 seconds** — a 76% drop on that codebase. Your numbers will vary with repo size, query, and model.


<div align="center">
  <h3>No API keys. No cloud. No Docker.<br />Just bun and SQLite.</h3>
  <h3>
    <a href="wiki/modules/search/index.md">Semantic Search</a> &nbsp;·&nbsp;
    <a href="wiki/index.md">Auto-generated Wiki</a>
    <br>
    <a href="wiki/modules/conversation/index.md">Cross-session Memory</a> &nbsp;·&nbsp;
    <a href="wiki/modules/graph/index.md">Dependency Graphs</a> &nbsp;·&nbsp;
    <a href="docs/tools.md#">Annotations</a>
  </h3>
  <span>Works with: Claude Code &nbsp;·&nbsp; Cursor &nbsp;·&nbsp; Windsurf &nbsp;·&nbsp; JetBrains (Junie) &nbsp;·&nbsp; GitHub Copilot &nbsp;·&nbsp; any MCP client</span>
</div>

## Quick start

### 1. Install SQLite (macOS)

Apple's bundled SQLite doesn't support extensions:

```bash
brew install sqlite
```

### 2. Set up your editor

```bash
bunx mimirs init --ide claude   # or: cursor, windsurf, copilot, jetbrains, all
```

This creates the MCP server config, editor rules, `.mimirs/config.json`, and `.gitignore` entry. Run with `--ide all` to set up every supported editor at once.

### 3. Try the demo (optional)

```bash
bunx mimirs demo
```

## Search quality

90–98% Recall@10. Benchmarked on four real codebases across three languages (120 queries total) — from 97 files to 8,553 — with known expected results per query. Full methodology in [BENCHMARKS.md](BENCHMARKS.md).

| Codebase | Language | Files | Queries | Recall@10 | MRR | Zero-miss |
|---|---|---|---|---|---|---|
| mimirs | TypeScript | 97 | 30 | 98.3% | 0.683 | 0.0% |
| Excalidraw | TypeScript | 693 | 30 | 96.7% | 0.442 | 3.3% |
| Django | Python | 3,090 | 30 | 93.3% | 0.688 | 6.7% |
| Kubernetes | Go | 8,553 | 30 | 90.0% | 0.589 | 10.0% |

Kubernetes excludes test files and demotes generated files. With `searchTopK: 15`, recall reaches 100%. See [Kubernetes benchmarks](BENCHMARKS.md#kubernetes-8553-files-30-queries) for details.

## How it compares

|  | mimirs | No tool (grep + Read) | Context stuffing | Cloud RAG services |
|---|---|---|---|---|
| Setup | One command | Nothing | Nothing | API keys, accounts |
| Token cost | ~91K/prompt | ~380K/prompt | Entire codebase | Varies |
| Search quality | 90–98% Recall@10 | Depends on keywords | N/A (everything loaded) | Varies |
| Code understanding | AST-aware (24 langs) | Line-level | None | Usually line-level |
| Cross-session memory | Conversations + checkpoints | None | None | Some |
| Privacy | Fully local | Local | Local | Data leaves your machine |
| Price | Free | Free | High token bills | $10-50/mo + tokens |

## Why not an existing tool?

- **Continue.dev's `@codebase`** — closest overlap (local RAG, open source), but retrieval lives inside the editor extension. Mimirs is a standalone MCP server with explicit tools (`search`, `read_relevant`, `project_map`, `search_conversation`, `annotate`) the agent can plan around, plus conversation tailing and a wiki generator built in.
- **Aider's repo-map** — static tree-sitter summary of the repo, no embeddings. Clever and lightweight, but a summary isn't retrieval — mimirs ranks chunks per query with vector + BM25 and boosts by graph centrality.
- **Sourcegraph Cody / OpenCtx** — excellent at code search, but indexing leans on cloud infra and an account. Mimirs is one `bunx` away and never leaves your machine.
- **llama-index / LangChain / roll-your-own** — those are libraries. Mimirs is batteries-included: AST-aware chunking, hybrid retrieval, file watcher, conversation tail, and annotations already wired together.

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

- [Example tool outputs](docs/examples.md) — what your agent actually receives over MCP
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

All data lives in `.mimirs/` inside your project — add it to `.gitignore`.