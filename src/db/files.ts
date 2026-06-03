import { Database } from "bun:sqlite";
import { type EmbeddedChunk } from "../types";
import { type StoredFile } from "./types";
import { normalizePath } from "../utils/path";
import { clearFileGraph } from "./graph";
import { identifierParts } from "../indexing/identifiers";

export function getFileByPath(db: Database, path: string): StoredFile | null {
  return db
    .query<StoredFile, [string]>(
      "SELECT id, path, hash, indexed_at as indexedAt FROM files WHERE path = ?"
    )
    .get(normalizePath(path));
}

/**
 * Batch-fetch many files by path in a single SQL pass. Returns only the
 * rows that exist; missing paths are silently omitted (caller should diff).
 * Used by the wiki bundle builder so a 1k-member community needs one query
 * instead of N round-trips.
 */
export function getFilesByPaths(db: Database, paths: string[]): StoredFile[] {
  if (paths.length === 0) return [];
  const normalized = paths.map(normalizePath);
  const BATCH = 499;
  const out: StoredFile[] = [];
  for (let i = 0; i < normalized.length; i += BATCH) {
    const batch = normalized.slice(i, i + BATCH);
    const ph = batch.map(() => "?").join(",");
    out.push(
      ...db
        .query<StoredFile, string[]>(
          `SELECT id, path, hash, indexed_at as indexedAt FROM files WHERE path IN (${ph})`,
        )
        .all(...batch),
    );
  }
  return out;
}

/**
 * Begin a full (re)index: clear any existing chunks and ensure a files row
 * exists, but record an EMPTY hash as an "in progress" marker. The caller must
 * call updateFileHash() only after all chunks are durably written. Committing
 * the real hash up front (the old behavior) meant an abort/crash mid-index left
 * a row whose hash matched the file but had zero chunks — so the file was
 * "Skipped (unchanged)" forever. An empty hash never matches real content, so
 * an interrupted index is always retried.
 */
export function upsertFileStart(db: Database, path: string): number {
  path = normalizePath(path);
  const existing = getFileByPath(db, path);
  if (existing) {
    // UPDATE instead of DELETE+INSERT to preserve files.id — this keeps
    // file_imports.resolved_file_id FKs pointing at this file intact.
    // Deleting the chunks fires the chunks_vec_ad trigger, which drops the
    // matching vec_chunks rows — no manual vec cleanup needed.
    const tx = db.transaction(() => {
      db.run("DELETE FROM chunks WHERE file_id = ?", [existing.id]);
      db.run(
        "UPDATE files SET hash = '', indexed_at = ? WHERE id = ?",
        [new Date().toISOString(), existing.id]
      );
    });
    tx();
    return existing.id;
  }

  db.run(
    "INSERT INTO files (path, hash, indexed_at) VALUES (?, '', ?)",
    [path, new Date().toISOString()]
  );
  return Number(
    db.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!.id
  );
}

/**
 * Update only the file hash and indexed_at timestamp, without deleting chunks.
 * Used by incremental chunk updates where we selectively delete/add chunks.
 */
export function updateFileHash(db: Database, fileId: number, hash: string): void {
  db.run(
    "UPDATE files SET hash = ?, indexed_at = ? WHERE id = ?",
    [hash, new Date().toISOString(), fileId]
  );
}

export function insertChunkBatch(
  db: Database,
  fileId: number,
  chunks: EmbeddedChunk[],
  startIndex: number
): number[] {
  const ids: number[] = [];
  const tx = db.transaction(() => {
    for (let i = 0; i < chunks.length; i++) {
      const { snippet, embedding, entityName, chunkType, startLine, endLine, contentHash, parentId } = chunks[i];
      db.run(
        "INSERT INTO chunks (file_id, chunk_index, snippet, entity_name, chunk_type, start_line, end_line, content_hash, parent_id, parts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [fileId, startIndex + i, snippet, entityName ?? null, chunkType ?? null, startLine ?? null, endLine ?? null, contentHash ?? null, parentId ?? null, identifierParts(snippet)]
      );
      const chunkId = Number(
        db.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!.id
      );
      ids.push(chunkId);
      db.run(
        "INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)",
        [chunkId, new Uint8Array(embedding.buffer)]
      );
    }
  });
  tx();
  return ids;
}

/** Map of `content_hash → chunk_id` for a single file. Used by incremental
 *  reindex to rebuild ref tables without re-deriving chunk-id ↔ content
 *  alignment from scratch. Skips parent chunks (chunk_index = -1) and any
 *  rows missing content_hash (legacy chunks pre-content-hash migration). */
export function getChunkIdsByHash(db: Database, fileId: number): Map<string, number> {
  const rows = db
    .query<{ id: number; content_hash: string | null }, [number]>(
      `SELECT id, content_hash FROM chunks
       WHERE file_id = ? AND chunk_index >= 0 AND content_hash IS NOT NULL`
    )
    .all(fileId);
  const map = new Map<string, number>();
  for (const r of rows) {
    if (r.content_hash) map.set(r.content_hash, r.id);
  }
  return map;
}

/** Insert a single chunk and return its DB id (used for parent chunks). */
export function insertChunkReturningId(
  db: Database,
  fileId: number,
  chunk: EmbeddedChunk,
  chunkIndex: number
): number {
  const { snippet, embedding, entityName, chunkType, startLine, endLine, contentHash } = chunk;
  db.run(
    "INSERT INTO chunks (file_id, chunk_index, snippet, entity_name, chunk_type, start_line, end_line, content_hash, parts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [fileId, chunkIndex, snippet, entityName ?? null, chunkType ?? null, startLine ?? null, endLine ?? null, contentHash ?? null, identifierParts(snippet)]
  );
  const chunkId = Number(
    db.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!.id
  );
  db.run(
    "INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)",
    [chunkId, new Uint8Array(embedding.buffer)]
  );
  return chunkId;
}

/**
 * Return the tree-sitter chunk ranges for a file, sorted by `start_line`
 * ascending. Drives the line-range verification lint: given a cited
 * `path:L1-L2`, find the chunk whose range covers L1 and compare against
 * the stored `[start_line, end_line]`. Language-agnostic — bun-chunk
 * populates these for every indexed file.
 *
 * Same-entity chunks are coalesced into one logical range. Bun-chunk
 * splits large symbols (a 100-LOC function gets two chunks) and ships
 * each piece with the same `entity_name`. A citation that points at the
 * symbol — `src/search/hybrid.ts:313-397` for `search()` — should match
 * the union, not the first split. Without this fold, the lint accepts
 * the first chunk's range as authoritative and drift goes uncaught.
 *
 * Anonymous chunks (`entity_name IS NULL`) stay as individual rows: they
 * have no logical-grouping key and pass through one-to-one.
 */
export function getFileChunkRanges(
  db: Database,
  filePath: string,
): { entityName: string | null; chunkType: string | null; startLine: number; endLine: number }[] {
  const raw = db
    .query<
      {
        entity_name: string | null;
        chunk_type: string | null;
        start_line: number | null;
        end_line: number | null;
      },
      [string]
    >(
      `SELECT c.entity_name, c.chunk_type, c.start_line, c.end_line
       FROM chunks c JOIN files f ON f.id = c.file_id
       WHERE f.path = ?
         AND c.start_line IS NOT NULL
         AND c.end_line IS NOT NULL
       ORDER BY c.start_line ASC`,
    )
    .all(normalizePath(filePath));

  type Range = { entityName: string | null; chunkType: string | null; startLine: number; endLine: number };
  const grouped = new Map<string, Range>();
  const anonymous: Range[] = [];

  for (const row of raw) {
    const r: Range = {
      entityName: row.entity_name,
      chunkType: row.chunk_type,
      startLine: row.start_line as number,
      endLine: row.end_line as number,
    };
    if (!r.entityName) {
      anonymous.push(r);
      continue;
    }
    const existing = grouped.get(r.entityName);
    if (!existing) {
      grouped.set(r.entityName, r);
    } else {
      existing.startLine = Math.min(existing.startLine, r.startLine);
      existing.endLine = Math.max(existing.endLine, r.endLine);
    }
  }

  return [...grouped.values(), ...anonymous].sort(
    (a, b) => a.startLine - b.startLine || a.endLine - b.endLine,
  );
}

/** Fetch a chunk by its DB id (for parent chunk lookup at query time). */
export function getChunkById(
  db: Database,
  chunkId: number
): { snippet: string; entityName: string | null; chunkType: string | null; startLine: number | null; endLine: number | null; path: string } | null {
  return db
    .query<
      { snippet: string; entity_name: string | null; chunk_type: string | null; start_line: number | null; end_line: number | null; path: string },
      [number]
    >(
      `SELECT c.snippet, c.entity_name, c.chunk_type, c.start_line, c.end_line, f.path
       FROM chunks c JOIN files f ON f.id = c.file_id
       WHERE c.id = ?`
    )
    .all(chunkId)
    .map((row) => ({
      snippet: row.snippet,
      entityName: row.entity_name,
      chunkType: row.chunk_type,
      startLine: row.start_line,
      endLine: row.end_line,
      path: row.path,
    }))[0] ?? null;
}

export function upsertFile(
  db: Database,
  path: string,
  hash: string,
  chunks: EmbeddedChunk[]
) {
  const fileId = upsertFileStart(db, path);
  insertChunkBatch(db, fileId, chunks, 0);
  // Commit the hash only after chunks are written (see upsertFileStart).
  updateFileHash(db, fileId, hash);
}

export function removeFile(db: Database, path: string): boolean {
  const existing = getFileByPath(db, normalizePath(path));
  if (!existing) return false;

  const tx = db.transaction(() => {
    // DELETE FROM chunks fires chunks_vec_ad, which clears the file's
    // vec_chunks rows. clearFileGraph handles the graph tables (no FK cascade).
    db.run("DELETE FROM chunks WHERE file_id = ?", [existing.id]);
    clearFileGraph(db, existing.id);
    db.run("DELETE FROM files WHERE id = ?", [existing.id]);
  });

  tx();
  return true;
}

export function pruneDeleted(db: Database, existingPaths: Set<string>): number {
  const allFiles = db
    .query<{ id: number; path: string }, []>("SELECT id, path FROM files")
    .all();

  // Normalize the existing-set so the comparison works on Windows where
  // callers may pass `\`-separated paths.
  const normalized = new Set<string>();
  for (const p of existingPaths) normalized.add(normalizePath(p));
  const toRemove = allFiles.filter(f => !normalized.has(f.path));
  if (toRemove.length === 0) return 0;

  const tx = db.transaction(() => {
    for (const file of toRemove) {
      // DELETE FROM chunks fires chunks_vec_ad to clear vec_chunks;
      // clearFileGraph handles the graph tables (no FK cascade).
      db.run("DELETE FROM chunks WHERE file_id = ?", [file.id]);
      clearFileGraph(db, file.id);
      db.run("DELETE FROM files WHERE id = ?", [file.id]);
    }
  });
  tx();
  return toRemove.length;
}

/**
 * Get all content hashes for chunks belonging to a file.
 * Returns empty array if no chunks have hashes (e.g. heuristic-chunked files).
 */
export function getChunkHashes(db: Database, fileId: number): Set<string> {
  const rows = db
    .query<{ content_hash: string }, [number]>(
      "SELECT content_hash FROM chunks WHERE file_id = ? AND content_hash IS NOT NULL"
    )
    .all(fileId);
  return new Set(rows.map(r => r.content_hash));
}

/**
 * Delete chunks (and their vec embeddings) whose content_hash is NOT in the keep set.
 * Returns the number of chunks deleted.
 */
export function deleteStaleChunks(db: Database, fileId: number, keepHashes: Set<string>): number {
  const allChunks = db
    .query<{ id: number; content_hash: string | null }, [number]>(
      "SELECT id, content_hash FROM chunks WHERE file_id = ?"
    )
    .all(fileId);

  const toDelete = allChunks.filter(c => !c.content_hash || !keepHashes.has(c.content_hash));
  if (toDelete.length === 0) return 0;

  const tx = db.transaction(() => {
    for (const c of toDelete) {
      // chunks_vec_ad trigger drops the matching vec_chunks row.
      db.run("DELETE FROM chunks WHERE id = ?", [c.id]);
    }
  });
  tx();
  return toDelete.length;
}

/**
 * Re-index existing chunks: update chunk_index, start_line, end_line for kept chunks.
 */
export function updateChunkPositions(
  db: Database,
  fileId: number,
  updates: { contentHash: string; chunkIndex: number; startLine: number | null; endLine: number | null }[]
) {
  const tx = db.transaction(() => {
    for (const u of updates) {
      db.run(
        "UPDATE chunks SET chunk_index = ?, start_line = ?, end_line = ? WHERE file_id = ? AND content_hash = ?",
        [u.chunkIndex, u.startLine, u.endLine, fileId, u.contentHash]
      );
    }
  });
  tx();
}

export function getAllFilePaths(db: Database): { id: number; path: string }[] {
  return db
    .query<{ id: number; path: string }, []>("SELECT id, path FROM files")
    .all();
}

export function getStatus(db: Database): { totalFiles: number; totalChunks: number; lastIndexed: string | null } {
  const files = db
    .query<{ count: number }, []>("SELECT COUNT(*) as count FROM files")
    .get()!;
  const chunks = db
    .query<{ count: number }, []>("SELECT COUNT(*) as count FROM chunks")
    .get()!;
  const last = db
    .query<{ indexed_at: string }, []>(
      "SELECT indexed_at FROM files ORDER BY indexed_at DESC LIMIT 1"
    )
    .get();

  return {
    totalFiles: files.count,
    totalChunks: chunks.count,
    lastIndexed: last?.indexed_at ?? null,
  };
}
