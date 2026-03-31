# local-rag

Semantic search for your codebase and conversation history, zero config, with built-in gap analysis.

Indexes any files — markdown, code, configs, docs — into a per-project vector store. Also indexes AI conversation transcripts in real time, so agents can recall past decisions and discussions. Usage analytics show you where your docs are falling short.

No API keys. No cloud. No Docker. Just `bunx`.

[![npm](https://img.shields.io/npm/v/@winci/local-rag)](https://www.npmjs.com/package/@winci/local-rag)
[![license](https://img.shields.io/npm/l/@winci/local-rag)](LICENSE)

**100% recall** on codebases, even at **8.7k files** (Kubernetes, with config tuning) — no cloud, no API keys. Hybrid vector + BM25 search, AST-aware chunking across 23 languages, and dependency graph boost. Full benchmarks in [BENCHMARKS.md](BENCHMARKS.md).

## Why

- **AI agents guess filenames.** Semantic search finds the right doc even if it's called `runbook-prod-release.md`.
- **Analytics expose documentation gaps.** See which topics people search for but can't find.
- **Refactoring is blind.** `find_usages` enumerates every call site across the codebase before you change anything.
- **Agents work on stale mental models.** `git_context` surfaces uncommitted changes and recent commits in one call.
- **Known issues get rediscovered every session.** `annotate` persists notes on files or symbols that surface automatically in search results.

## Quick start

Works with [Claude Code](https://claude.ai/code), [Cursor](https://cursor.sh), [Windsurf](https://codeium.com/windsurf), and [VS Code Copilot](https://code.visualstudio.com/).

### 1. Install SQLite (macOS)

Apple's bundled SQLite doesn't support extensions:

```bash
brew install sqlite
```

### 2. Set up your editor

```bash
bunx @winci/local-rag init --ide claude   # or: cursor, windsurf, copilot, all
```

This creates the MCP server config, editor rules, `.rag/config.json`, and `.gitignore` entry — everything needed to start searching. Run with `--ide all` to set up every supported editor at once.

### 3. Try the demo (optional)

```bash
bunx @winci/local-rag demo
```

### Claude Code plugin

For deeper integration, local-rag is also available as a Claude Code plugin.

> **Note:** The plugin has passed Anthropic's review process but is not yet visible in the marketplace. In the meantime, you can install it manually:
>
> ```bash
> git clone https://github.com/TheWinci/local-rag.git
> claude --plugin-dir ./local-rag
> ```

The plugin adds **SessionStart** (context summary), **PostToolUse** (auto-reindex on edit), and **SessionEnd** (auto-checkpoint) hooks. No `CLAUDE.md` instructions needed — the plugin's built-in skill handles tool usage.

## Documentation

- [MCP tools, CLI & analytics](docs/tools.md)
- [Configuration & examples](docs/configuration.md)
- [Benchmarks](BENCHMARKS.md)

## Supported file types

Files are detected by extension or by basename (for files like `Dockerfile.prod`). Each type gets a dedicated chunking strategy so chunks land on meaningful boundaries.

### AST-aware (tree-sitter)

Uses [bun-chunk](https://github.com/TheWinci/bun-chunk) to extract function/class/interface/enum boundaries via tree-sitter grammars. Import and export symbols are captured for the dependency graph.

| Extensions | Notes |
|---|---|
| `.ts` `.tsx` `.js` `.jsx` | TypeScript & JavaScript |
| `.py` `.pyi` | Python |
| `.go` | Go |
| `.rs` | Rust |
| `.java` | Java |
| `.c` `.h` | C |
| `.cpp` `.cc` `.cxx` `.hpp` `.hh` `.hxx` | C++ |
| `.cs` | C# |
| `.rb` | Ruby |
| `.php` | PHP |
| `.scala` `.sc` | Scala |
| `.kt` `.kts` | Kotlin |
| `.lua` | Lua |
| `.zig` `.zon` | Zig |
| `.ex` `.exs` | Elixir |
| `.hs` `.lhs` | Haskell |
| `.ml` `.mli` | OCaml |
| `.sh` `.bash` `.zsh` | Bash / Zsh |
| `.toml` | TOML |
| `.yaml` `.yml` | YAML |
| `.html` `.htm` | HTML |
| `.css` `.scss` `.less` | CSS / SCSS / LESS (**not indexed by default**) |

### Other supported formats

| Type | Extensions / patterns |
|---|---|
| Structured data | `.yaml` `.yml` `.json` `.toml` `.xml` |
| Build & CI | `Makefile` `Dockerfile` `Jenkinsfile` `Vagrantfile` `Gemfile` `Rakefile` `Procfile` |
| Infrastructure | `.tf` `.proto` `.graphql` `.gql` `.sql` `.mod` `.bru` |
| Shell | `.sh` `.bash` `.zsh` `.fish` |
| Docs | `.md` `.mdx` `.markdown` `.txt` |

> Files not matching any known extension fall back to paragraph splitting and are still searchable.

## How it works

1. **Parse & chunk** — Walks your project, splits content using a type-matched strategy — function/class boundaries for code (via tree-sitter), headings for markdown, top-level keys for YAML/JSON, etc.

2. **Embed** — Each chunk is embedded into a 384-dimensional vector using all-MiniLM-L6-v2 (in-process via Transformers.js + ONNX, no API calls). Vectors are stored in sqlite-vec.

3. **Build dependency graph** — Import specifiers and exported symbols are captured during AST chunking, then resolved using bun-chunk's filesystem resolver with DB-based fallback.

4. **Hybrid search** — Queries run vector similarity and BM25 in parallel, blended by `hybridWeight`. Results are boosted by dependency graph centrality and path heuristics. `read_relevant` returns individual chunks with entity names and **exact line ranges** (`path:start-end`).

5. **Watch & re-index** — File changes are detected with a 2-second debounce. Changed files are re-indexed and import relationships re-resolved. Deleted files are pruned automatically.

6. **Conversation & checkpoints** — Tails Claude Code's JSONL transcripts in real time. Agents can create checkpoints at important moments for future sessions to search.

7. **Annotations** — Notes attached to files or symbols surface as `[NOTE]` blocks inline in `read_relevant` results.

8. **Analytics** — Every query is logged. Analytics surface zero-result queries, low-relevance queries, and period-over-period trends.

## Search quality

Benchmarked on four codebases with known expected files per query. Full details in [BENCHMARKS.md](BENCHMARKS.md).

| Codebase | Language | Files | Queries | Recall@10 | MRR | Zero-miss |
|---|---|---|---|---|---|---|
| local-rag (this project) | TypeScript | 97 | 20 | 100.0% | 0.651 | 0.0% |
| Express.js | JavaScript | 161 | 15 | 100.0% | 0.922 | 0.0% |
| Excalidraw | TypeScript | 676 | 20 | 100.0% | 0.366 | 0.0% |
| Kubernetes | Go | 8,691 | 20 | 100.0%* | 0.496 | 0.0%* |

\*With config tuning. At default top-10, Recall is 80%. See [BENCHMARKS.md](BENCHMARKS.md) for details.

## Stack

| Layer | Choice |
|---|---|
| Runtime | Bun (built-in SQLite, fast TS) |
| AST chunking | [bun-chunk](https://github.com/TheWinci/bun-chunk) — tree-sitter grammars for 23 languages |
| Embeddings | Transformers.js + ONNX (in-process, no daemon) |
| Embedding model | all-MiniLM-L6-v2 (~23MB, 384 dimensions) — [configurable](docs/configuration.md) |
| Vector store | sqlite-vec (single `.db` file) |
| MCP | @modelcontextprotocol/sdk (stdio transport) |
| Plugin | Claude Code plugin with skills + hooks |

## Per-project storage

All data lives in `.rag/` inside your project — add it to `.gitignore`. During indexing, progress is written to `.rag/status` (auto-deleted when done). Monitor with `watch -n1 cat .rag/status`.
