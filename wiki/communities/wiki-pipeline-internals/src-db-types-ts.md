# src/db/types.ts

> [Architecture](../../architecture.md) › [Wiki Pipeline — Types & Internals](../wiki-pipeline-internals.md)
>
> Generated from `79e963f` · 2026-04-26

## Role

`src/db/types.ts` defines the raw database row shapes and query result interfaces that the DB layer returns and the wiki pipeline consumes. It is a pure type file — no logic, no imports — that acts as the boundary contract between SQLite persistence and everything above it.

## Exports

| Name | Kind | Signature | What it does |
|------|------|-----------|--------------|
| `StoredChunk` | interface | `export interface StoredChunk` | A chunk row as stored in the DB: id, fileId, chunkIndex, snippet text, optional entity name and type, source line range, and parent chunk id for nested constructs (e.g. a method inside a class). |
| `StoredFile` | interface | `export interface StoredFile` | A file row: numeric id, project-relative path, content hash, and ISO timestamp of last indexing. |
| `SearchResult` | interface | `export interface SearchResult` | Lightweight result from a hybrid search: file path, relevance score, snippet preview, chunk index, entity name, and chunk type. No line numbers — use `ChunkSearchResult` when you need them. |
| `ChunkSearchResult` | interface | `export interface ChunkSearchResult` | Extended search result with full chunk content and line-range fields (`startLine`, `endLine`, `parentId`). Used by `read_relevant` responses and lint passes that need to verify line numbers. |
| `UsageResult` | interface | `export interface UsageResult` | A single usage site for a symbol: file path, line number (nullable), and a snippet of the importing line. |
| `AnnotationRow` | interface | `export interface AnnotationRow` | A persisted annotation: id, file path, optional symbol name, free-text note, optional author, and created/updated timestamps. |
| `SymbolResult` | interface | `export interface SymbolResult` | A classified symbol from `file_exports`: path, symbol name and type, optional snippet, chunk index, parent/child counts, reference counts across files and modules, module name list, and a re-export flag. |
| `CheckpointRow` | interface | `export interface CheckpointRow` | A saved checkpoint: id, session id, turn index, timestamp, type, title, summary, involved file paths, and tags. |
| `GitCommitRow` | interface | `export interface GitCommitRow` | A git commit stored in the history index: id, full and short hash, message, author name and email, date, changed file paths, insertion/deletion counts, merge flag, ref names, and optional diff summary. |
| `GitCommitSearchResult` | interface | `export interface GitCommitSearchResult extends GitCommitRow` | Extends `GitCommitRow` with a `score` field for semantic search ranking. |
| `ConversationSearchResult` | interface | `export interface ConversationSearchResult` | A matched conversation turn from the conversation index: turn id and index, session id, timestamp, summary, snippet, tools used, referenced files, and relevance score. |
| `PathFilter` | interface | `export interface PathFilter` | Scoping filter accepted by search and symbol queries: optional `extensions` array, `dirs` array, and `excludeDirs` array. All fields are optional; an empty filter means "no restriction". |

## Internals

- **`SearchResult` vs `ChunkSearchResult` is a deliberate split.** `SearchResult` carries only what the MCP `search` tool needs to render a file-path-plus-snippet response. `ChunkSearchResult` carries the full chunk content and line numbers needed by `read_relevant` and the lint pipeline. Keeping them separate prevents the search hot path from paying the cost of fetching line ranges it will never use.

- **`SymbolResult.referenceModules` is already aggregated.** The DB query that produces `SymbolResult` joins across the `file_exports` and import-graph tables to collect the set of module names that reference the symbol. Callers do not need to aggregate themselves — but the list is capped by the DB query and may be a sample on highly-referenced symbols.

- **`StoredChunk.parentId` enables nested-symbol reconstruction.** When the AST chunker emits a method inside a class, it sets `parentId` to the class chunk's id. The lint pipeline uses this to reconstruct the enclosing symbol's line range when detecting line-range drift on a method chunk.

- **`PathFilter` fields are all optional and additive.** Passing `{ extensions: [".ts"] }` restricts to TypeScript files; passing `{ dirs: ["src/wiki"] }` restricts to one subtree; combining them ANDs the constraints. An empty or absent filter means "no restriction" — not "match nothing". This is different from a WHERE clause where a missing column value would be NULL.

## See also

- [Architecture](../../architecture.md)
- [Data flows](../../data-flows.md)
- [Getting started](../../getting-started.md)
- [src/wiki/community-synthesis.ts](community-synthesis.md)
- [src/wiki/content-prefetch.ts](content-prefetch.md)
- [src/wiki/types.ts](src-wiki-types-ts.md)
- [Wiki Pipeline — Types & Internals](../wiki-pipeline-internals.md)
