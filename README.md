<div align="center">

<img src="https://raw.githubusercontent.com/TheWinci/mimirs/e30e4b62385b827b953c00a4a283b787707018cc/mimirs-logo-2.png" width="200" alt="mimirs">

# mimirs

**Persistent project memory for AI coding agents.**

</div>

---

## Why the name

In Norse myth, Odin preserved the head of Mímir and consulted it for counsel long after Mímir died.
Knowledge that outlives the moment, and answers when asked.

That is the idea. An agent should not rediscover or relearn your codebase every session.

## Mission

Coding agents burn most of their budget re-reading files they have already read `mimirs` gives them a durable, local index of a project — semantic search over AST-aware chunks (tree-sitter), plus memory that persists across sessions.

Everything runs on your machine. No API keys, no code leaves the repo.

## Status

`2.0.0-alpha` is a Rust rewrite. It gives an agent source context for a
query: a ranked file map, then code excerpts. Memory across sessions is not
in 2.0 yet. Setup is manual, and it runs on macOS and Linux; Windows is
untested.

The stable release is still the TypeScript implementation on npm:

```sh
npm install -g mimirs
```

## Install

Build it with Rust 1.89 or newer:

```sh
cargo install --git https://github.com/TheWinci/mimirs --branch version/2.x
```

This puts `mimirs` in `~/.cargo/bin`. ONNX Runtime, SQLite, and vector
search are built in, so nothing else needs to be installed.

## Set up a project

Run these in the project's root folder:

```sh
mimirs init
mimirs index
```

`init` creates `.mimirs/` with a `config.toml` and downloads the embedding
model (about 24 MB) once per machine. Edit `include` and `exclude` in
`config.toml` to choose which files are indexed. `index` builds the index in
`.mimirs/index.db`; later runs only index files that changed.

## Connect your agent

`mimirs mcp` keeps the index current while your agent runs. It watches the
project, indexes changes, and offers no tools: the agent queries through the
CLI. Give it the project folder with `--root`.

For Claude Code, add this to `.mcp.json` in the project root:

```json
{
  "mcpServers": {
    "mimirs": {
      "command": "mimirs",
      "args": ["mcp", "--root", "/absolute/path/to/project"]
    }
  }
}
```

For VS Code, add this to `.vscode/mcp.json`:

```json
{
  "servers": {
    "mimirs": {
      "type": "stdio",
      "command": "mimirs",
      "args": ["mcp", "--root", "/absolute/path/to/project"]
    }
  }
}
```

Keep `--root` and the path as two separate items in `args`. If the client
cannot find `mimirs`, use the full path, such as `/Users/you/.cargo/bin/mimirs`.

Several sessions on one project are fine: one server indexes, and the others
wait and take over when it exits.

## Tell your agent to use mimirs

Add this to the project's `AGENTS.md` (or `CLAUDE.md`):

````markdown
## Finding code with mimirs

Before you search or read files to understand code, run:

```sh
mimirs context "what you need, as a short description of the behavior"
```

It prints the most relevant files with the line of their best match, then
code excerpts cited as `path:start-end`. Read the excerpts first; open a file
only when you need more than they show.

- Describe behavior in plain words, such as "retry failed uploads with
  backoff", not a single identifier.
- Use `--budget <bytes>` for more or less code (default 16000) and
  `--files <n>` for a longer or shorter file map (default 20).
- If the first line starts with `Indexing failed`, tell the user: the index
  may be stale until the MCP server restarts.
````

## When something goes wrong

`.mimirs/status` records what the indexer is doing or why it stopped:

```sh
cat .mimirs/status
```

The first line is the state: `catching up` (with progress), `watching`,
`indexed`, `error` (with the message), or `stopped` (with the reason). Agent
clients often hide the server's error output, so check this file first.

## Benchmark

Recall@k is the share of a query's expected files found in the first k
files; MRR averages 1 / rank of the first expected file. The query sets come
from v1's benchmark. Measured at `06b8d24b` on 2026-10-13 with
`python3 benchmarks/run.py --index`.

| Project | Files | Queries | R@5 | R@10 | R@20 | MRR | v1 R@10 / MRR |
|---|---|---|---|---|---|---|---|
| mimirs v1 | 338 | 74 | 99.3% | 99.3% | 100% | 0.928 | 95.3% / 0.759 |
| Excalidraw | 695 | 72 | 97.2% | 98.6% | 98.6% | 0.880 | 90.3% / 0.773 |
| Django | 3,729 | 116 | 99.1% | 100% | 100% | 0.936 | 97.4% / 0.727 |
| Kubernetes | 8,790 | 120 | 90.0% | 97.5% | 98.3% | 0.774 | 89.2% / 0.689 |
| Weighted | | 382 | 95.9% | 98.8% | 99.2% | 0.873 | |

## License

Apache-2.0