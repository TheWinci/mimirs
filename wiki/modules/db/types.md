# types

Single-file home for the eleven row-shape interfaces and one filter interface that move between the DB and the rest of the codebase. Nothing here executes — `types.ts` is pure declarations, imported by the per-concern files in `src/db/*` and re-exported through `src/db/index.ts` so callers can `import { StoredChunk, SearchResult, ... } from "../db"` without knowing which sub-file actually defines them.

**Source:** `src/db/types.ts`

## Public API

```ts
interface StoredFile {
  id: number;
  path: string;
  hash: string;
  indexedAt: string;
}

interface StoredChunk {
  id: number;
  fileId: number;
  chunkIndex: number;
  snippet: string;
  entityName: string | null;
  chunkType: string | null;
  startLine: number | null;
  endLine: number | null;
  parentId: number | null;
}

interface SearchResult {
  path: string;
  score: number;
  snippet: string;
  chunkIndex: number;
  entityName: string | null;
  chunkType: string | null;
}

interface ChunkSearchResult {
  path: string;
  score: number;
  content: string;
  chunkIndex: number;
  entityName: string | null;
  chunkType: string | null;
  startLine: number | null;
  endLine: number | null;
  parentId: number | null;
}

interface UsageResult {
  path: string;
  line: number | null;
  snippet: string;
}

interface SymbolResult {
  path: string;
  symbolName: string;
  symbolType: string;
  snippet: string | null;
  chunkIndex: number | null;
  hasChildren: boolean;
  childCount: number;
  referenceCount: number;
  referenceModuleCount: number;
  referenceModules: string[];
  isReexport: boolean;
}

interface AnnotationRow {
  id: number;
  path: string;
  symbolName: string | null;
  note: string;
  author: string | null;
  createdAt: string;
  updatedAt: string;
}

interface CheckpointRow {
  id: number;
  sessionId: string;
  turnIndex: number;
  timestamp: string;
  type: string;
  title: string;
  summary: string;
  filesInvolved: string[];
  tags: string[];
}

interface ConversationSearchResult {
  turnId: number;
  turnIndex: number;
  sessionId: string;
  timestamp: string;
  summary: string;
  snippet: string;
  toolsUsed: string[];
  filesReferenced: string[];
  score: number;
}

interface GitCommitRow {
  id: number;
  hash: string;
  shortHash: string;
  message: string;
  authorName: string;
  authorEmail: string;
  date: string;
  filesChanged: string[];
  insertions: number;
  deletions: number;
  isMerge: boolean;
  refs: string[];
  diffSummary: string | null;
}

interface GitCommitSearchResult extends GitCommitRow {
  score: number;
}

interface PathFilter {
  extensions?: string[];
  dirs?: string[];
  excludeDirs?: string[];
}
```

## How the shapes map to callers

| Interface | Where it's produced | Where it's consumed |
|---|---|---|
| `StoredFile` | `getFileByPath`, `getAllFilePaths` | indexer path resolution, graph resolver `pathToId` map |
| `StoredChunk` | `getChunkById` | parent-grouping in hybrid search, `read_relevant` formatting |
| `SearchResult` | `vectorSearch`, `textSearch` | file-level hybrid ranking |
| `ChunkSearchResult` | `vectorSearchChunks`, `textSearchChunks` | `read_relevant`, chunk-anchored `path:start-end` output |
| `UsageResult` | `find_usages` | MCP `find_usages` tool output |
| `SymbolResult` | `searchSymbols` | MCP `search_symbols` tool output |
| `AnnotationRow` | `getAnnotations`, `searchAnnotations` | `[NOTE]` injection into `read_relevant` results |
| `CheckpointRow` | `getCheckpoint`, `listCheckpoints`, `searchCheckpoints` | checkpoint MCP tools |
| `ConversationSearchResult` | `searchConversation`, `textSearchConversation` | `search_conversation` tool |
| `GitCommitRow` | `getFileHistory` (and `parseRow` internal helper) | `file_history` tool |
| `GitCommitSearchResult` | `searchGitCommits`, `textSearchGitCommits` | `search_commits` tool |
| `PathFilter` | caller-constructed | `vectorSearch*`, `textSearch*`, `read_relevant`, `search` |

## Usage

These interfaces cross module boundaries constantly. The convention is to import from `../db`, not `../db/types`:

```ts
// src/search/hybrid.ts
import { RagDB, type SearchResult, type ChunkSearchResult } from "../db";

// src/tools/search.ts
import { type AnnotationRow } from "../db";

// src/wiki/content-prefetch.ts
import type { StoredChunk, StoredFile } from "../db";
```

Result types pair with their query on the DB side. A chunk-level search returns `ChunkSearchResult[]` because the caller needs `startLine` / `endLine` to format `path:42-67` references; a file-level search returns `SearchResult[]` because the caller only needs per-file ranking.

## Dependencies

| Direction | Target | Notes |
|---|---|---|
| Imported by | `src/db/index.ts` | Re-exports every interface so callers see them through the facade |
| Imported by | `src/db/search.ts` | Uses `SearchResult`, `ChunkSearchResult`, `SymbolResult`, `UsageResult`, `PathFilter` |
| Imported by | `src/db/conversation.ts` | Uses `ConversationSearchResult` |
| Imported by | `src/db/git-history.ts` | Uses `GitCommitRow`, `GitCommitSearchResult` |
| Imported by | `src/db/files.ts` | Uses `StoredFile` |

`types.ts` imports nothing itself — it sits at the leaf of the db module's internal graph.

## See also

- [db](index.md)
- [files](files.md)
- [graph](graph.md)
- [conversation](conversation.md)
- [git-history](git-history.md)
- [Architecture](../../architecture.md)
