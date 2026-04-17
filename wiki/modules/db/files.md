# files

The file-and-chunk write path. `files.ts` owns the SQL that turns `EmbeddedChunk[]` into `chunks` + `vec_chunks` rows, keeps `file.hash` in sync with what was actually embedded, and prunes rows when disk state changes. The `RagDB` facade forwards `upsertFile`, `insertChunkBatch`, `getFileByPath`, `getAllFilePaths`, `removeFile`, `pruneDeleted`, and `getStatus` directly to the functions declared here.

**Source:** `src/db/files.ts`

## Key exports

| Function | Shape | Purpose |
|---|---|---|
| `getFileByPath(db, path)` | `→ StoredFile \| null` | Primary lookup — single indexed row by absolute path |
| `getAllFilePaths(db)` | `→ { id, path }[]` | Used by `pruneDeleted` and by the graph resolver's `pathToId` map |
| `upsertFileStart(db, path, hash)` | `→ fileId: number` | Streaming-write entry point — deletes old chunks/vec rows inside a transaction, updates `files.hash` + `indexed_at`, returns the existing id so FKs in `file_imports.resolved_file_id` survive |
| `upsertFile(db, path, hash, chunks)` | `→ fileId` | One-shot version — start + insert the whole batch at `startIndex=0` |
| `insertChunkBatch(db, fileId, chunks, startIndex)` | `→ void` | Transaction-wrapped insert; for each chunk, writes one row to `chunks` and one to `vec_chunks` with `embedding` as a `Uint8Array` view over the float buffer |
| `removeFile(db, path)` | `→ boolean` | Deletes one `files` row; cascade clears `chunks`, `vec_chunks`, `file_imports`, `file_exports`, `fts_chunks` |
| `pruneDeleted(db, existingPaths)` | `→ count` | Batch delete — any `files.path` not in the `Set` is dropped; runs once per `indexDirectory` after the walk |
| `getStatus(db)` | `→ { totalFiles, totalChunks, lastIndexed, dbSizeBytes }` | Surface for `mimirs status` and the MCP `index_status` tool |

## Usage examples

`upsertFileStart` is the entry point for the streaming incremental path used by the indexer:

```ts
// src/indexing/indexer.ts — processFileIncremental
const fileId = upsertFileStart(db, path, contentHash);
insertChunkBatch(db, fileId, newChunks, startIndex);
```

The watcher uses the same pair when a single file changes:

```ts
// src/indexing/watcher.ts
upsertFile(db, changedPath, newHash, embeddedChunks);
```

The `pruneDeleted` call fires once at the end of a walk:

```ts
// src/indexing/indexer.ts
const removed = pruneDeleted(db, new Set(walkedPaths));
if (removed > 0) log.info(`Pruned ${removed} stale files`);
```

And consumers read the index via the direct getters:

```ts
// src/graph/resolver.ts
const byPath = new Map<string, number>();
for (const { id, path } of getAllFilePaths(db)) byPath.set(path, id);
```

## Dependencies

| Direction | Target | Notes |
|---|---|---|
| Imports | `bun:sqlite` | `Database` parameter is the open connection from `RagDB` |
| Imports | `../types.EmbeddedChunk`, `./types.StoredFile` | Pure shape imports |

## Internals

- **`upsertFileStart` updates instead of delete+insert.** Preserving `files.id` keeps every `file_imports.resolved_file_id` FK pointing at the file intact. A delete+insert would orphan every inbound edge and force a second resolver pass.
- **Embeddings are stored as raw bytes.** `new Uint8Array(embedding.buffer)` hands `sqlite-vec` the float-32 buffer directly; no per-cell conversion. This is why schema init has to size `vec_chunks` to match `getEmbeddingDim()` — mismatched dims produce bogus neighbours without throwing.
- **Every write is in a transaction.** `insertChunkBatch` wraps the chunk + vec inserts in `db.transaction(() => ...)`, and `upsertFileStart` wraps the delete + update. WAL mode plus the `busy_timeout=5000` from the facade's `initSchema` keep these writes compatible with concurrent searches.
- **`chunk_index` is per-file, positional.** `startIndex` lets the incremental path append chunks without re-numbering the kept ones.

## See also

- [db](index.md)
- [types](types.md)
- [graph](graph.md)
- [Architecture](../../architecture.md)
- [Data Flows](../../data-flows.md)
