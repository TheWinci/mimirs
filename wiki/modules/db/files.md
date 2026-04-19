# files

The file-and-chunk write path. `files.ts` owns the SQL that turns `EmbeddedChunk[]` into `chunks` + `vec_chunks` rows, keeps `files.hash` in sync with what was actually embedded, and prunes rows when disk state changes. The `RagDB` facade forwards `upsertFile`, `upsertFileStart`, `updateFileHash`, `insertChunkBatch`, `insertChunkReturningId`, `getChunkById`, `getFileByPath`, `getAllFilePaths`, `removeFile`, `pruneDeleted`, `getChunkHashes`, `deleteStaleChunks`, `updateChunkPositions`, and `getStatus` directly to the functions declared here.

**Source:** `src/db/files.ts`

## Public API

```ts
function getFileByPath(db: Database, path: string): StoredFile | null;

function getAllFilePaths(db: Database): { id: number; path: string }[];

function upsertFileStart(db: Database, path: string, hash: string): number;

function upsertFile(
  db: Database,
  path: string,
  hash: string,
  chunks: EmbeddedChunk[]
): void;

function updateFileHash(db: Database, fileId: number, hash: string): void;

function insertChunkBatch(
  db: Database,
  fileId: number,
  chunks: EmbeddedChunk[],
  startIndex: number
): void;

function insertChunkReturningId(
  db: Database,
  fileId: number,
  chunk: EmbeddedChunk,
  chunkIndex: number
): number;

function getChunkById(
  db: Database,
  chunkId: number
): {
  snippet: string;
  entityName: string | null;
  chunkType: string | null;
  startLine: number | null;
  endLine: number | null;
  path: string;
} | null;

function removeFile(db: Database, path: string): boolean;

function pruneDeleted(db: Database, existingPaths: Set<string>): number;

function getChunkHashes(db: Database, fileId: number): Set<string>;

function deleteStaleChunks(
  db: Database,
  fileId: number,
  keepHashes: Set<string>
): number;

function updateChunkPositions(
  db: Database,
  fileId: number,
  updates: {
    contentHash: string;
    chunkIndex: number;
    startLine: number | null;
    endLine: number | null;
  }[]
): void;

function getStatus(db: Database): {
  totalFiles: number;
  totalChunks: number;
  lastIndexed: string | null;
};
```

## Row shapes touched

The functions read and write three tables:

- **`files(id, path, hash, indexed_at)`** — one row per indexed file. `path` is the absolute path; `hash` is the content hash computed in the indexer; `indexed_at` is an ISO timestamp updated on every upsert.
- **`chunks(id, file_id, chunk_index, snippet, entity_name, chunk_type, start_line, end_line, content_hash, parent_id)`** — N rows per file, one per semantic chunk. `chunk_index` is positional within the file; `content_hash` enables incremental re-index; `parent_id` links child chunks to their enclosing parent.
- **`vec_chunks(chunk_id, embedding)`** — one vec0 row per chunk, `embedding FLOAT[getEmbeddingDim()]` sized at schema-init time.

## Usage

`upsertFileStart` is the entry point for the streaming incremental path. It preserves `files.id` so inbound `file_imports.resolved_file_id` FKs stay intact:

```ts
// src/indexing/indexer.ts — processFileIncremental
const fileId = upsertFileStart(db, path, contentHash);
insertChunkBatch(db, fileId, newChunks, startIndex);
```

The one-shot `upsertFile` is used by the watcher when a single file changes:

```ts
// src/indexing/watcher.ts
upsertFile(db, changedPath, newHash, embeddedChunks);
```

Hash-based incremental writes use `getChunkHashes` + `deleteStaleChunks` + `insertChunkBatch` with `updateFileHash` as the finalizer:

```ts
const kept = getChunkHashes(db, fileId);             // existing content hashes
deleteStaleChunks(db, fileId, new Set(newHashes));   // drop chunks not in new set
insertChunkBatch(db, fileId, addedChunks, startIdx); // append new ones
updateFileHash(db, fileId, fileHash);                // then stamp the file hash
```

`pruneDeleted` fires once at the end of a walk:

```ts
// src/indexing/indexer.ts
const removed = pruneDeleted(db, new Set(walkedPaths));
if (removed > 0) log.info(`Pruned ${removed} stale files`);
```

Consumers read the index via the direct getters:

```ts
// src/graph/resolver.ts
const byPath = new Map<string, number>();
for (const { id, path } of getAllFilePaths(db)) byPath.set(path, id);
```

## Dependencies

| Direction | Target | Notes |
|---|---|---|
| Imports | `bun:sqlite` | `Database` parameter is the open connection from `RagDB` |
| Imports | `../types.EmbeddedChunk` | Write-side chunk shape with `embedding: Float32Array` |
| Imports | `./types.StoredFile` | Read-side row shape |

## Internals

- **`upsertFileStart` updates instead of delete + insert.** Preserving `files.id` keeps every `file_imports.resolved_file_id` FK pointing at this file intact. A delete + insert would orphan every inbound edge and force a second resolver pass.
- **Embeddings are stored as raw bytes.** `new Uint8Array(embedding.buffer)` hands `sqlite-vec` the float-32 buffer directly; no per-cell conversion. This is why `vec_chunks` must be sized to `getEmbeddingDim()` at schema init — mismatched dims produce bogus neighbours without throwing.
- **Every write is in a transaction.** `insertChunkBatch` wraps every chunk + vec insert in `db.transaction(() => ...)`; `upsertFileStart` wraps the old-chunk delete + `files` update. WAL mode plus `busy_timeout=5000` from the facade keep these compatible with concurrent searches.
- **`chunk_index` is per-file, positional.** `startIndex` lets the incremental path append chunks without renumbering the kept ones; `updateChunkPositions` reassigns `chunk_index`/`start_line`/`end_line` for kept chunks keyed by `content_hash` when the file shifts but the chunk text survives.
- **Vec deletes are explicit.** `removeFile`, `pruneDeleted`, `upsertFileStart`, and `deleteStaleChunks` all loop over the old `chunks.id` set and `DELETE FROM vec_chunks WHERE chunk_id = ?` row-by-row before dropping the chunk rows themselves — `vec_chunks` has no ON DELETE CASCADE to the core table.
- **`getChunkById` is a JOIN.** Returns `{ snippet, entityName, chunkType, startLine, endLine, path }` by joining `chunks` to `files` so parent-chunk lookups in hybrid search don't need a second round-trip.

## See also

- [db](index.md)
- [types](types.md)
- [graph](graph.md)
- [Architecture](../../architecture.md)
- [Data Flows](../../data-flows.md)
