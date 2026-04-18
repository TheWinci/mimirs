# MCP tools

These tools are available to any MCP client (Claude Code, Cursor, Windsurf, VS Code Copilot) once the server is running:

| Tool | What it does |
|---|---|
| `search` | Semantic search over indexed files — returns ranked paths, scores, and 400-char snippets. Supports `extensions`, `dirs`, `excludeDirs` scope filters |
| `read_relevant` | Chunk-level retrieval — returns top-N individual semantic chunks ranked by relevance, with entity names and full content. No file deduplication — two chunks from the same file can both appear. Same scope filters as `search` |
| `index_files` | Index files in a directory — skips unchanged files, prunes deleted ones |
| `index_status` | Show file count, chunk count, last indexed time |
| `remove_file` | Remove a specific file from the index |
| `search_analytics` | Usage analytics — query counts, zero-result queries, low-relevance queries, top terms |
| `project_map` | Generate a dependency graph of the project — file-level or directory-level, with optional focus |
| `search_conversation` | Search conversation history — finds past decisions, discussions, and tool outputs across sessions |
| `create_checkpoint` | Mark an important moment — decisions, milestones, blockers, direction changes, or handoffs |
| `list_checkpoints` | List checkpoints, most recent first. Filter by session or type |
| `search_checkpoints` | Semantic search over checkpoint titles and summaries |
| `search_symbols` | Find exported symbols by name — functions, classes, types, interfaces, enums. Faster than semantic search when you know the symbol name |
| `find_usages` | Find every call site of a symbol across the codebase — returns file paths, line numbers (`path:line`), and the matching line. Excludes the defining file |
| `git_context` | Show uncommitted changes (annotated `[indexed]`/`[not indexed]`), recent commits, and changed files. Optional unified diff (`include_diff`). Non-git directories return a graceful message |
| `search_commits` | Semantically search indexed git commit history — find why code changed, when decisions were made, or what an author worked on. Supports filters: `author`, `since`, `until`, `path`, `threshold` |
| `file_history` | Get the commit history for a specific file — returns commits that touched it, sorted by date (newest first) |
| `annotate` | Attach a persistent note to a file or symbol. Notes survive sessions and surface inline in `read_relevant` results. Upserts by `(path, symbol)` key |
| `get_annotations` | Retrieve notes by file path, or search semantically across all annotations |
| `depends_on` | List all files that a given file imports (its dependencies) |
| `depended_on_by` | List all files that import a given file (reverse dependencies) |
| `write_relevant` | Find the best insertion point for new content — returns semantically appropriate files and anchors |
| `generate_wiki` | Generate or update a structured markdown wiki for the codebase — returns step-by-step instructions that the agent follows using other mimirs tools. Supports incremental updates |

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
mimirs benchmark [dir]    # Run search quality benchmark
mimirs eval [dir]         # A/B eval harness
mimirs history            # Git history subcommands (index, search, status)
mimirs conversation       # Conversation subcommands (search, sessions, index)
mimirs checkpoint         # Checkpoint subcommands (create, list, search)
mimirs annotations [dir]  # List annotations (optionally filter by --path)
mimirs session-context    # Session start context summary (used by hook)
mimirs demo [dir]         # Interactive feature demo
```

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
