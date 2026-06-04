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
    <a href="wiki/tools/search.md">Semantic Search</a> &nbsp;·&nbsp;
    <a href="wiki/tools/wiki.md">Auto-generated Wiki</a>
    <br>
    <a href="wiki/tools/search-conversation.md">Cross-session Memory</a> &nbsp;·&nbsp;
    <a href="wiki/tools/project-map.md">Dependency Graphs</a> &nbsp;·&nbsp;
    <a href="wiki/tools/annotate.md">Annotations</a>
  </h3>
  <span>Works with: Claude Code &nbsp;·&nbsp; Cursor &nbsp;·&nbsp; Windsurf &nbsp;·&nbsp; JetBrains (Junie) &nbsp;·&nbsp; GitHub Copilot &nbsp;·&nbsp; any MCP client</span>
</div>

<div align="center">
  <img src="demo.gif" alt="mimirs: index a repo, then search, read, and find affected tests — from the terminal" width="900">
</div>

## Quick start

### 1. Prerequisites

[Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`) and, on macOS, a modern SQLite — Apple's bundled one doesn't support extensions:

```bash
brew install sqlite
```

Linux and Windows ship with a compatible SQLite already.

### 2. Set up your editor (automatic)

```bash
bunx mimirs init --ide claude   # or: cursor, windsurf, copilot, jetbrains, all
```

This creates the MCP server config, editor rules, `.mimirs/config.json`, and `.gitignore` entry. Run with `--ide all` to set up every supported editor at once.

`init` covers Claude Code, Cursor, Windsurf, Copilot, and JetBrains (Junie). For everything else — Codex, Zed, custom clients — copy one of the snippets below.

### 3. Set up your editor (manual reference)

The mimirs MCP server runs over stdio. Every client needs the same three things: a `command` (`bunx`), `args` (`["mimirs@latest", "serve"]`), and a `RAG_PROJECT_DIR` env var pointing at your project root.

<details>
<summary><b>Claude Code</b> — <code>.mcp.json</code> in project root</summary>

```json
{
  "mcpServers": {
    "mimirs": {
      "command": "bunx",
      "args": ["mimirs@latest", "serve"],
      "env": {
        "RAG_PROJECT_DIR": "/absolute/path/to/your/project"
      }
    }
  }
}
```
</details>

<details>
<summary><b>Cursor</b> — <code>.cursor/mcp.json</code> in project root</summary>

```json
{
  "mcpServers": {
    "mimirs": {
      "command": "bunx",
      "args": ["mimirs@latest", "serve"],
      "env": {
        "RAG_PROJECT_DIR": "/absolute/path/to/your/project"
      }
    }
  }
}
```
</details>

<details>
<summary><b>Windsurf</b> — <code>~/.codeium/windsurf/mcp_config.json</code> (global)</summary>

Windsurf reads MCP servers from your home directory, not the project. JetBrains plugin variant uses `~/.codeium/mcp_config.json`.

```json
{
  "mcpServers": {
    "mimirs": {
      "command": "bunx",
      "args": ["mimirs@latest", "serve"],
      "env": {
        "RAG_PROJECT_DIR": "/absolute/path/to/your/project"
      }
    }
  }
}
```
</details>

<details>
<summary><b>JetBrains (Junie)</b> — <code>.junie/mcp.json</code> in project root</summary>

```json
{
  "mcpServers": {
    "mimirs": {
      "command": "bunx",
      "args": ["mimirs@latest", "serve"],
      "env": {
        "RAG_PROJECT_DIR": "/absolute/path/to/your/project"
      }
    }
  }
}
```
</details>

<details>
<summary><b>GitHub Copilot</b> — <code>.vscode/mcp.json</code> in project root</summary>

VS Code's Copilot uses a `servers` map (not `mcpServers`) and a `type` field.

```json
{
  "servers": {
    "mimirs": {
      "type": "stdio",
      "command": "bunx",
      "args": ["mimirs@latest", "serve"],
      "env": {
        "RAG_PROJECT_DIR": "/absolute/path/to/your/project"
      }
    }
  }
}
```
</details>

<details>
<summary><b>Codex</b> — <code>~/.codex/config.toml</code> (global)</summary>

Codex uses TOML, not JSON, and reads from `~/.codex/config.toml`. One block per project — pick a unique table name if you wire up multiple repos (`mimirs-frontend`, `mimirs-api`, etc).

```toml
[mcp_servers.mimirs]
command = "bunx"
args = ["mimirs@latest", "serve"]
env = { RAG_PROJECT_DIR = "/absolute/path/to/your/project" }
```

Or, equivalently, with an expanded env table:

```toml
[mcp_servers.mimirs]
command = "bunx"
args = ["mimirs@latest", "serve"]

[mcp_servers.mimirs.env]
RAG_PROJECT_DIR = "/absolute/path/to/your/project"
```
</details>

<details>
<summary><b>Read-only project directory?</b> Redirect the index</summary>

If the project lives in a read-only mount, set `RAG_DB_DIR` to a writable location. The index lives there instead of `<project>/.mimirs/`.

```json
{
  "mcpServers": {
    "mimirs": {
      "command": "bunx",
      "args": ["mimirs@latest", "serve"],
      "env": {
        "RAG_PROJECT_DIR": "/read/only/project",
        "RAG_DB_DIR": "/home/me/.cache/mimirs/myproject"
      }
    }
  }
}
```
</details>

### 4. First index

The MCP server indexes lazily on the first query, so once it's wired up you can just ask your agent something. To force a full index up front (useful for large repos):

```bash
bunx mimirs index            # current directory
bunx mimirs status           # how many files, chunks, embeddings
```

### 5. Try the demo (optional)

```bash
bunx mimirs demo
```

## Manual workflow (without `init`)

`init` is a convenience: it wires up your editor (MCP config, agent rules, `.gitignore`, `.mimirs/config.json`). It does **not** build the index, and nothing below needs it — the index and a default config are created automatically the first time you index or query.

**1. Add the MCP server by hand.** Drop the snippet for your client from the [manual reference](#3-set-up-your-editor-manual-reference) above: `command: "bunx"`, `args: ["mimirs@latest", "serve"]`, and `RAG_PROJECT_DIR` pointing at your project root. That is the entire MCP setup.

> Without `init` there's no agent-rules file, so your assistant won't know the tools exist. Either mention mimirs in your prompt, or copy the tool list from [CLAUDE.md](CLAUDE.md) into your editor's rules.

**2. Build the index.** The MCP server indexes lazily on the first tool call, so through an agent you can skip this step. To index up front (recommended for large repos, and required before the CLI `search`/`read` below):

```bash
bunx mimirs index                                # current directory
bunx mimirs index /path/to/repo                  # a specific directory
bunx mimirs index --patterns "src/**/*.ts,*.md"  # restrict to globs
bunx mimirs status                               # files, chunks, embeddings
```

No `init` and no config file required — defaults are applied and the index is written to `<project>/.mimirs/`.

**3. Query from the CLI.** Two read commands, both running against the index in the current directory (use `--dir` to point elsewhere):

```bash
# Where is it? — ranked file paths + snippet previews
bunx mimirs search "where is auth handled" --top 10

# What is it? — the actual matching code chunks (functions, classes, sections)
bunx mimirs read "jwt validation" --top 8 --threshold 0.3
```

Scope either with `--ext .ts,.tsx`, `--in src,packages/core`, or `--exclude tests`. Note: the CLI `search`/`read` do **not** auto-index — run `mimirs index` first (only the MCP server indexes on demand).

## Claude Code plugin

For deeper integration, mimirs is also available as a Claude Code plugin. In a Claude Code session:

```
/plugin marketplace add https://github.com/TheWinci/mimirs.git
/plugin install mimirs
```

The plugin wires the MCP server, three hooks — **SessionStart** (context summary), **PostToolUse** (auto-reindex on edit), **SessionEnd** (auto-checkpoint) — and a set of **workflow skills** that orchestrate the tools for common jobs: `explore`, `review`, `debug`, `catch-up`, `recall`, `doc-gaps`, and `wiki`.

**Want the skills without the plugin?** They're plain `SKILL.md` files under [skills/](skills/). Copy any you like into your project's `.claude/skills/<name>/` (shared with the repo) or `~/.claude/skills/<name>/` (all your projects) and Claude Code picks them up next session. Skills are a Claude Code feature, so they don't apply to other editors — but the MCP tools themselves work everywhere.

## Search quality

89–97% Recall@10, 97–100% Recall@20, MRR 0.69–0.77. Benchmarked on four real codebases across three languages with stratified, difficulty-mixed query sets (72–120 queries each, ~⅓ hard), re-measured 2026-06-04 on the current pipeline. Full methodology in [BENCHMARKS.md](BENCHMARKS.md).

| Codebase | Language | Files | Queries | Recall@10 | MRR | Zero-miss |
|---|---|---|---|---|---|---|
| mimirs | TypeScript | 244 | 74 | 95.3% | 0.759 | 4.1% |
| Excalidraw | TypeScript | 693 | 72 | 90.3% | 0.773 | 9.7% |
| Django | Python | 3,181 | 116 | 97.4% | 0.727 | 2.6% |
| Kubernetes | Go | 8,792 | 120 | 89.2% | 0.689 | 10.8% |

The larger repos (Kubernetes, Excalidraw) are big enough that some correct files rank just past the top-10; recall reaches 97–100% by top-20, so set `searchTopK: 15–20` on large repos.

## How it compares

|  | mimirs | No tool (grep + Read) | Context stuffing | Cloud RAG services |
|---|---|---|---|---|
| Setup | One command | Nothing | Nothing | API keys, accounts |
| Token cost | ~91K/prompt | ~380K/prompt | Entire codebase | Varies |
| Search quality | 89–97% Recall@10 | Depends on keywords | N/A (everything loaded) | Varies |
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

3. **Build dependency graph** — Import specifiers and exported symbols are captured during AST chunking, then resolved to build a file-level dependency graph and a symbol-level call graph. `impact` walks the transitive callers of a function (blast radius + tests to run); `trace` finds how one symbol reaches another; the `mimirs affected` CLI turns a git diff into the exact set of tests to run.

4. **Hybrid search** — Queries run vector similarity and BM25 in parallel, combined by reciprocal-rank fusion (weighted, default 0.5) — robust to the two scorers' very different score scales. Identifiers are split (camelCase/snake_case) so a search for `depends` matches `getDependsOn`. Results are then boosted by dependency graph centrality and path heuristics. `read_relevant` returns individual chunks with entity names and exact line ranges (`path:start-end`).

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