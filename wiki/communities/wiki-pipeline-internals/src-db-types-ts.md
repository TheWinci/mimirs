# src/db/types.ts

> [Architecture](../../architecture.md) › [Wiki Pipeline — Types & Internals](../wiki-pipeline-internals.md)
>
> Generated from `b47d98e` · 2026-04-26

## Role

`src/db/types.ts` is the typed contract between the SQLite layer (`src/db/index.ts`) and every consumer that reads from it — search handlers, the wiki categorizer, and the wiki's internal type module. It declares twelve flat interfaces (no enums, no helper types, no defaults) that together describe the row and search-result shapes the database returns. The file is pure type declarations: no runtime code, no imports, no exports beyond the interfaces themselves. Consumers either map a SQLite row into one of these shapes inside `src/db/index.ts` or accept a typed result downstream.

## Exports

| Name | Kind | Signature | What it does |
|------|------|-----------|--------------|
| `StoredChunk` | interface | `interface StoredChunk { id, fileId, chunkIndex, snippet, entityName, chunkType, startLine, endLine, parentId }` | One row from the chunks table. `entityName`, `chunkType`, `startLine`, `endLine`, and `parentId` are nullable because plain text or markdown chunks have no AST symbol or parent. |
| `StoredFile` | interface | `interface StoredFile { id, path, hash, indexedAt }` | One row from the files table. `hash` is the content hash used for incremental skip-detection; `indexedAt` is an ISO timestamp string. |
| `SearchResult` | interface | `interface SearchResult { path, score, snippet, chunkIndex, entityName, chunkType }` | Trimmed search-result shape returned by hybrid search — only the fields a UI needs, no chunk content. |
| `ChunkSearchResult` | interface | `interface ChunkSearchResult { path, score, content, chunkIndex, entityName, chunkType, startLine, endLine, parentId }` | Heavier variant that includes the full `content` of the chunk plus line range and parent chunk id. Used by `read_relevant`. |
| `UsageResult` | interface | `interface UsageResult { path, line, snippet }` | A single call site — minimal shape returned by `find_usages`. `line` is nullable when the symbol is referenced in a chunk without resolved line metadata. |
| `AnnotationRow` | interface | `interface AnnotationRow { id, path, symbolName, note, author, createdAt, updatedAt }` | One row from the annotations table. `symbolName` is `null` for file-level notes; `author` defaults to `"agent"` upstream but may be null when historical rows are read back. |
| `SymbolResult` | interface | `interface SymbolResult { path, symbolName, symbolType, snippet, chunkIndex, hasChildren, childCount, referenceCount, referenceModuleCount, referenceModules, isReexport }` | Symbol search result with reference fan-out. `referenceModules` is the deduplicated list of importing module paths, `referenceModuleCount` is its length, and `referenceCount` is the raw call-site count. |
| `CheckpointRow` | interface | `interface CheckpointRow { id, sessionId, turnIndex, timestamp, type, title, summary, filesInvolved, tags }` | One row from the checkpoints table. `filesInvolved` and `tags` are deserialized JSON arrays — SQLite stores them as text, the DB layer parses them before returning. |
| `GitCommitRow` | interface | `interface GitCommitRow { id, hash, shortHash, message, authorName, authorEmail, date, filesChanged, insertions, deletions, isMerge, refs, diffSummary }` | One row from the git commits table. `filesChanged` and `refs` are JSON-decoded; `diffSummary` is nullable because the indexer only stores it for non-merge commits. |
| `GitCommitSearchResult` | interface | `interface GitCommitSearchResult extends GitCommitRow { score: number }` | A `GitCommitRow` plus the hybrid-search score. The extension keeps the row fields stable so formatters can be shared between chronological and ranked views. |
| `ConversationSearchResult` | interface | `interface ConversationSearchResult { turnId, turnIndex, sessionId, timestamp, summary, snippet, toolsUsed, filesReferenced, score }` | Conversation hybrid-search hit. `toolsUsed` and `filesReferenced` are deserialized arrays extracted at index time from the turn's tool calls and file paths. |
| `PathFilter` | interface | `interface PathFilter { extensions?, dirs?, excludeDirs? }` | The optional filter passed to most search calls. All fields are arrays of strings; absence means "no filter". The `excludeDirs` field is applied after `dirs`, so a directory listed in both is excluded. |

## Internals

- **All array-valued columns are stored as JSON strings, decoded by the DB layer.** `CheckpointRow.filesInvolved`, `CheckpointRow.tags`, `GitCommitRow.filesChanged`, `GitCommitRow.refs`, `ConversationSearchResult.toolsUsed`, `ConversationSearchResult.filesReferenced`, and `SymbolResult.referenceModules` are all `string[]` in the type, but SQLite holds the raw JSON. Code reading these rows must trust the DB layer's parse — never re-parse a value already typed as `string[]`.
- **Nullable line ranges signal "no AST".** `StoredChunk.startLine`, `StoredChunk.endLine`, `ChunkSearchResult.startLine`, `ChunkSearchResult.endLine`, and `UsageResult.line` are nullable specifically because non-code chunks (markdown, plain text) skip AST extraction. Code that formats `path:start-end` must guard against `null` and fall back to `path` alone.
- **`SearchResult` and `ChunkSearchResult` differ only in payload weight.** Both carry `path`, `score`, `chunkIndex`, `entityName`, `chunkType`; the lightweight `SearchResult` ships `snippet` (a truncated preview) while `ChunkSearchResult` ships `content` (the full chunk body) plus line range and parent. Choosing the wrong type at the call boundary leaks either too little context (UI can't show the chunk) or too much (transport bloats unnecessarily).
- **`SymbolResult.isReexport` is the de-dup signal.** A symbol that appears in a re-export chain shows up with `isReexport: true` so callers can filter or annotate. `hasChildren` and `childCount` exist to distinguish leaf symbols from container types (classes, namespaces) without a follow-up query.
- **`PathFilter.excludeDirs` overrides `PathFilter.dirs`.** When both are set, `dirs` defines the candidate set and `excludeDirs` removes from it — there is no union semantic. This is documented at the call sites (search handlers) but invisible from the type declaration; a caller passing `dirs: ["src"], excludeDirs: ["src/legacy"]` gets the expected subset.
- **`GitCommitSearchResult extends GitCommitRow` is intentional inheritance.** The DB layer uses the same row mapper for both shapes and attaches `score` on the search path. A non-extending design (separate interfaces) would force two parallel mappers; the extension keeps the formatter helpers in `src/tools/git-history-tools.ts` (`formatCommitResult`, `formatCommitRow`) sharing logic on the row fields.

## See also

- [Architecture](../../architecture.md)
- [Data flows](../../data-flows.md)
- [Getting started](../../getting-started.md)
- [src/wiki/community-synthesis.ts](community-synthesis.md)
- [src/wiki/content-prefetch.ts](content-prefetch.md)
- [src/wiki/types.ts](src-wiki-types-ts.md)
- [Wiki Pipeline — Types & Internals](../wiki-pipeline-internals.md)
