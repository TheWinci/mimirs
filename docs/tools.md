# MCP tools

These tools are available to any MCP client (Claude Code, Cursor, Windsurf, VS Code Copilot) once the server is running:

| Tool | What it does |
|---|---|
| `search` | Semantic search over indexed files — returns ranked paths, scores, and 400-char snippets. Supports `extensions`, `dirs`, `excludeDirs` scope filters |
| `read_relevant` | Chunk-level retrieval — returns top-N individual semantic chunks ranked by relevance, with entity names and full content. No file deduplication — two chunks from the same file can both appear. Same scope filters as `search` |
| `index_files` | Index files in a directory. Without patterns it syncs the project index from config and prunes deleted/excluded files; with patterns it refreshes only matching files and leaves the rest of the index untouched |
| `index_status` | Show file count, chunk count, last indexed time |
| `remove_file` | Remove a specific file from the index |
| `search_analytics` | Usage analytics — query counts, zero-result queries, low-relevance queries, top terms |
| `project_map` | Generate a dependency graph of the project — file-level or directory-level, with optional `focus` and `hops` (focus neighborhood radius, default 2) |
| `search_conversation` | Search conversation history — finds past decisions, discussions, and tool outputs across sessions |
| `read_conversation` | Read full verbatim turns by session + turn index — the read counterpart to `search_conversation`'s snippets |
| `create_checkpoint` | Mark an important moment — decisions, milestones, blockers, direction changes, or handoffs |
| `list_checkpoints` | List checkpoints, most recent first. Filter by session or type |
| `search_checkpoints` | Semantic search over checkpoint titles and summaries |
| `search_symbols` | Find exported symbols by name — functions, classes, types, interfaces, enums. Faster than semantic search when you know the symbol name |
| `usages` | Find every call site of a symbol across the codebase — returns file paths, line numbers (`path:line`), and the matching line. Excludes the defining file |
| `git_context` | Show uncommitted changes (annotated `[indexed]`/`[not indexed]`), recent commits, and changed files. Optional unified diff (`include_diff`). Non-git directories return a graceful message |
| `search_commits` | Semantically search indexed git commit history — find why code changed, when decisions were made, or what an author worked on. Supports filters: `author`, `since`, `until`, `path`, `threshold` |
| `file_history` | Get the commit history for a specific file — returns commits that touched it, sorted by date (newest first) |
| `annotate` | Attach a persistent note to a file or symbol. Notes survive sessions and surface inline in `read_relevant` results. Upserts by `(path, symbol)` key |
| `get_annotations` | Retrieve notes by file path, or search semantically across all annotations |
| `depends_on` | List all files that a given file imports (its dependencies) |
| `dependents` | List all files that import a given file (reverse dependencies) |
| `impact` | Symbol-level blast radius — the transitive callers of a function/method as a pruned call tree, plus the test files to run (precise: reference the symbol; broad: import affected files). More precise than `dependents`. `file` disambiguates; `hops` (default 3, no hard cap) bounds the drawn tree depth and `maxNodes` (default 80) its size, while the headline total-caller count stays complete; `format: json` for structured output |
| `trace` | Show how one symbol reaches another — the connecting call sub-graph from `from` to `to`, shortest path highlighted. **Reachability is complete** (whole reachable graph searched, no hop limit), so "no path" means truly unreachable. Branches that don't reach `to` are pruned; `maxNodes` (default 300) bounds only the drawn sub-graph; static resolution reports when a dynamic-dispatch hop breaks the chain. `from_file`/`to_file` disambiguate, `format: json` for structured output |
| `write_relevant` | Find the best insertion point for new content — returns semantically appropriate files and anchors |
| `wiki` | Run the wiki rebuild workflow. `shape` writes prefetch data and returns the discovery prompt; `validate-discovery` checks `wiki/_discovery.json`; `write` and `write:page:<slug>` coordinate page writing by slug |

### Which graph/symbol tool?

These five overlap; pick by **granularity** (file vs symbol) × **direction**:

| You want to know… | Tool | Granularity / direction |
| --- | --- | --- |
| What does this **file** import? | `depends_on` | file · outward |
| What **files** import this file? (file-level blast radius) | `dependents` | file · inward |
| Where is this **symbol** called? (flat, 1-hop) | `usages` | symbol · inward |
| What transitively calls this **symbol**, and which tests to run? | `impact` | symbol · inward · transitive (+ tests) |
| How does symbol **A** reach symbol **B**? | `trace` | symbol · path between two endpoints |
| Big-picture file relationships / fan-in-out? | `project_map` | graph overview — `zoom` file or directory, optional `focus` on one neighborhood |

Rule of thumb: **file-level** = `depends_on`/`dependents`; **symbol-level** =
`usages` (flat) or `impact` (transitive + tests); **two named endpoints** =
`trace`. Each tool's description carries the same routing pointers inline.

## CLI

`mimirs` is a CLI-first tool. The MCP server runs as the `serve` subcommand.

```bash
mimirs serve              # Start MCP server (stdio transport)
mimirs init [dir]         # Set up editor config, rules, .mimirs/, .gitignore (--ide claude|cursor|windsurf|copilot|jetbrains|all)
mimirs index [dir]        # Index files in a directory
mimirs search <query>     # Semantic search
mimirs read <query>       # Chunk-level retrieval (like read_relevant)
mimirs status [dir]       # Show index stats
mimirs remove <path>      # Remove a file from the index
mimirs analytics [dir]    # Usage analytics with trend comparison
mimirs map [dir]          # Dependency graph (text format)
mimirs affected [files…]  # Test files affected by changed files (--stdin, --json, --quiet; no files → git diff vs HEAD)
mimirs benchmark [dir]    # Run search quality benchmark
mimirs eval [dir]         # A/B eval harness
mimirs history            # Git history subcommands (index, search, status)
mimirs conversation       # Conversation subcommands (search, sessions, index)
mimirs checkpoint         # Checkpoint subcommands (create, list, search)
mimirs annotations [dir]  # List annotations (optionally filter by --path)
mimirs session-context    # Session start context summary (used by hook)
mimirs demo [dir]         # Interactive feature demo
```

### `affected` — run only the tests a change touches

Walks the import graph transitively to find which test files a set of changed
files affects. Pipe a git diff in and run just those tests instead of the whole
suite:

```bash
# pre-commit / CI: test only what changed
AFFECTED=$(git diff --name-only HEAD | mimirs affected --stdin --quiet)
[ -n "$AFFECTED" ] && bun test $AFFECTED
```

With no file arguments it falls back to `git diff --name-only HEAD` itself. The
interactive counterpart is the `impact` tool, which reports the same tests for a
single symbol alongside its caller tree.

## Analytics

Every search is logged automatically. Use the `search_analytics` MCP tool to see what's working and what's not:

```
Search analytics (last 30 days):
  Total queries:    142
  Avg results:      3.2
  Avg top score:    0.58
  Zero-result rate: 12% (17 queries)

Top searches:
  3x "authentication flow"
  2x "database migrations"

Zero-result queries (consider indexing these topics):
  3x "kubernetes pod config"
  2x "slack webhook setup"

Low-relevance queries (top score < 0.3):
  "how to fix the build" (score: 0.21)
```

**Zero-result queries** tell you what topics your docs are missing. **Low-relevance queries** tell you where docs exist but don't answer the actual question. Both are actionable.

The analytics output also includes a **trend comparison** showing how metrics changed versus the prior period:

```
Trend (current 30d vs prior 30d):
  Queries:          142 (+38)
  Avg top score:    0.58 (+0.05)
  Zero-result rate: 12% (-3.0%)
```
