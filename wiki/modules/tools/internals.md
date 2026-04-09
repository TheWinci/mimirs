# Tools Internals

Detailed breakdown of each tool file in the Tools module.

## `search.ts` -- Search Tools

Contains four tools focused on finding and retrieving content from the index.

| Tool | Description |
|------|-------------|
| **`search`** | Discovers which files are relevant to a query. Returns file paths with snippet previews. Uses hybrid vector + BM25 search with score adjustments. |
| **`read_relevant`** | Returns actual content of relevant semantic chunks with exact line ranges (e.g., `src/db.ts:42-67`). Two chunks from the same file can both appear (no file deduplication). Inline annotations surface as `[NOTE]` blocks. |
| **`search_symbols`** | Finds symbols (functions, classes, types, exports) by name. Supports exact and fuzzy matching, with optional type filtering. |
| **`write_relevant`** | Finds the best insertion point for new code or documentation. Returns the most semantically appropriate file and anchor location. |

## `graph-tools.ts` -- Graph Tools

Contains four tools for navigating the project dependency graph.

| Tool | Description |
|------|-------------|
| **`project_map`** | Generates a Mermaid dependency graph at file or directory zoom level. Accepts a `focus` parameter to zoom into a specific file's neighborhood. Auto-switches to directory view when node count exceeds `maxNodes`. |
| **`find_usages`** | Finds all call sites of a symbol across the codebase. Returns file paths, line numbers, and matching lines. Excludes the defining file. |
| **`depends_on`** | Lists all files that a given file imports -- its direct dependencies. |
| **`depended_on_by`** | Lists all files that import a given file -- its reverse dependencies. |

## `index-tools.ts` -- Index Management Tools

Contains three tools for managing the file index.

| Tool | Description |
|------|-------------|
| **`index_files`** | Triggers indexing or re-indexing of project files. Supports incremental updates. Accepts optional glob pattern overrides. Reports progress via the status file. |
| **`index_status`** | Returns statistics about the current index: file count, chunk count, last indexed time. |
| **`remove_file`** | Removes a specific file and its chunks from the index. |

## `annotation-tools.ts` -- Annotation Tools

Contains three tools for attaching persistent notes to files and symbols.

| Tool | Description |
|------|-------------|
| **`annotate`** | Attaches a persistent note to a file or symbol (e.g., "known race condition", "don't refactor until auth rewrite lands"). Notes appear as `[NOTE]` blocks inline in `read_relevant` results. Upserts by `(path, symbol)` key. |
| **`get_annotations`** | Retrieves all annotations for a file, or searches semantically across all annotations. |
| **`delete_annotation`** | Removes an annotation by ID. Use `get_annotations` first to find the ID. |

## `checkpoint-tools.ts` -- Checkpoint Tools

Contains three tools for marking and searching project milestones.

| Tool | Description |
|------|-------------|
| **`create_checkpoint`** | Marks an important moment -- decisions, milestones, blockers, direction changes, handoffs. Includes title, summary, files involved, and tags. |
| **`list_checkpoints`** | Lists recent checkpoints in reverse chronological order. Optionally filters by session or type. |
| **`search_checkpoints`** | Searches checkpoints semantically to find past decisions and milestones. |

## `conversation-tools.ts` -- Conversation Tool

Contains one tool for searching past conversation history.

| Tool | Description |
|------|-------------|
| **`search_conversation`** | Searches indexed Claude Code conversation history using hybrid vector + BM25. Finds previous discussions, decisions, and tool outputs across sessions. Supports filtering by session ID. |

## `git-tools.ts` -- Git Tool

Contains one tool for git-aware context.

| Tool | Description |
|------|-------------|
| **`git_context`** | Shows uncommitted changes annotated with index status (`[indexed]`/`[not indexed]`), recent commits, and changed files. Optional unified diff. Non-git directories return a graceful message. |

## `analytics-tools.ts` -- Analytics Tool

Contains one tool for search quality insights.

| Tool | Description |
|------|-------------|
| **`search_analytics`** | Shows query counts, zero-result queries, low-relevance queries, top searched terms, and trend comparison vs prior period. Reveals documentation gaps and areas where the index needs improvement. |

## `server-info-tools.ts` -- Server Info Tool

Contains one tool and one type.

| Export | Description |
|--------|-------------|
| **`server_info`** (tool) | Returns server status, connected databases, embedding model, configuration, and index statistics. |
| **`ConnectedDBInfo`** (type) | Type describing a connected database's metadata: `projectDir`, `openedAt`, `lastAccessed`. |

## `wiki-tools.ts` -- Wiki Tool

Contains one tool for automated documentation generation.

| Tool | Description |
|------|-------------|
| **`generate_wiki`** | Generates a structured markdown wiki from the project's semantic index. Returns step-by-step instructions the agent follows using other mimirs tools. Supports incremental updates when `wiki/_manifest.json` exists. |

## See Also

- [Tools overview](index.md) -- module summary and full tools table
- [Search module](../search/) -- search logic behind `search` and `read_relevant`
- [Graph module](../graph/) -- graph logic behind `project_map` and dependency tools
- [Conversation module](../conversation/) -- indexing logic behind `search_conversation`
- [Server module](../server/) -- registers all tools at startup
- [API Surface](../../api-surface.md) -- complete tools reference
