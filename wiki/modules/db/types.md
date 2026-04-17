# types

Single-file home for the eleven row-shape interfaces that move between the DB and the rest of the codebase. Nothing here executes — `types.ts` is pure declarations, imported by the `RagDB` facade and the per-concern files in `src/db/*`, then re-exported through `src/db/index.ts` so callers can `import { StoredChunk, SearchResult, ... } from "../db"` without knowing which sub-file actually defines them.

**Source:** `src/db/types.ts`

## Key exports

| Interface | Purpose | Appears in results from |
|---|---|---|
| `StoredFile` | `{ id, path, hash, indexedAt }` — one row of `files` | `getFileByPath`, `getAllFilePaths` |
| `StoredChunk` | `{ id, fileId, chunkIndex, snippet, entityName, chunkType, startLine, endLine, parentId }` — one row of `chunks` | chunk lookups, parent-grouping |
| `SearchResult` | File-level vector/FTS hit — `{ path, score, snippet, chunkIndex, entityName, chunkType }` | `vectorSearch`, `textSearch` |
| `ChunkSearchResult` | Chunk-level hit with line ranges — adds `content`, `startLine`, `endLine`, `parentId` | `vectorSearchChunks`, `textSearchChunks` |
| `UsageResult` | `find_usages` hit — `{ path, line, snippet }` | usages scanner |
| `SymbolResult` | `search_symbols` hit with import/reference counts — `{ path, symbolName, symbolType, snippet, chunkIndex, hasChildren, childCount, referenceCount, referenceModuleCount, referenceModules, isReexport }` | `searchSymbols` |
| `AnnotationRow` | `{ id, path, symbolName?, note, author?, createdAt, updatedAt }` | `getAnnotations`, `searchAnnotations` |
| `CheckpointRow` | `{ id, sessionId, turnIndex, timestamp, type, title, summary, filesInvolved[], tags[] }` | `getCheckpoint`, `listCheckpoints` |
| `ConversationSearchResult` | `{ turnId, turnIndex, sessionId, timestamp, summary, snippet, toolsUsed[], filesReferenced[], score }` | `searchConversation`, `textSearchConversation` |
| `GitCommitRow` | `{ id, hash, shortHash, message, authorName, authorEmail, date, filesChanged[], insertions, deletions, isMerge, refs[], diffSummary? }` | commit reads |
| `GitCommitSearchResult` | `GitCommitRow & { score }` | `searchGitCommits`, `textSearchGitCommits` |

## Usage examples

These interfaces cross module boundaries constantly. The pattern is always the same — import from `../db`, not `../db/types`:

```ts
// src/search/hybrid.ts
import { RagDB, type SearchResult, type ChunkSearchResult } from "../db";

// src/tools/search.ts
import { type AnnotationRow } from "../db";

// src/wiki/content-prefetch.ts
import type { StoredChunk, StoredFile } from "../db";
```

Result types pair with their query on the DB side. For example, a chunk-level search returns `ChunkSearchResult[]` because the caller needs `startLine` / `endLine` to format `path:42-67` references; a file-level search returns `SearchResult[]` because the caller only needs per-file ranking.

## Dependencies

| Direction | Target | Notes |
|---|---|---|
| Imported by | `src/db/index.ts` | Re-exports every interface so callers see them through the facade |
| Imported by | `src/db/search.ts` | Uses `SearchResult`, `ChunkSearchResult`, `SymbolResult`, `UsageResult` as return types for the vector/FTS/symbol/usages queries |

`types.ts` imports nothing itself — it sits at the leaf of the db module's internal graph.

## See also

- [db](index.md)
- [files](files.md)
- [graph](graph.md)
- [conversation](conversation.md)
- [git-history](git-history.md)
- [Architecture](../../architecture.md)
