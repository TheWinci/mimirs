import { Database } from "bun:sqlite";
import { type EmbeddedChunk } from "../types";
import { type StoredFile } from "./types";

export function getFileByPath(db: Database, path: string): StoredFile | null {
  return db
    .query<StoredFile, [string]>(
      "SELECT id, path, hash, indexed_at as indexedAt FROM files WHERE path = ?"
    )
    .get(path);
}

export function upsertFileStart(db: Database, path: string, hash: string): number {
  const existing = getFileByPath(db, path);
  if (existing) {
    // UPDATE instead of DELETE+INSERT to preserve files.id — this keeps
    // file_imports.resolved_file_id FKs pointing at this file intact.
    const tx = db.transaction(() => {
      const oldChunks = db
        .query<{ id: number }, [number]>("SELECT id FROM chunks WHERE file_id = ?")
        .all(existing.id);
      for (const c of oldChunks) {
        db.run("DELETE FROM vec_chunks WHERE chunk_id = ?", [c.id]);
      }
      db.run("DELETE FROM chunks WHERE file_id = ?", [existing.id]);
      db.run(
        "UPDATE files SET hash = ?, indexed_at = ? WHERE id = ?",
        [hash, new Date().toISOString(), existing.id]
      );
    });
    tx();
    return existing.id;
  }

  db.run(
    "INSERT INTO files (path, hash, indexed_at) VALUES (?, ?, ?)",
    [path, hash, new Date().toISOString()]
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
) {
  const tx = db.transaction(() => {
    for (let i = 0; i < chunks.length; i++) {
      const { snippet, embedding, entityName, chunkType, startLine, endLine, contentHash } = chunks[i];
      db.run(
        "INSERT INTO chunks (file_id, chunk_index, snippet, entity_name, chunk_type, start_line, end_line, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [fileId, startIndex + i, snippet, entityName ?? null, chunkType ?? null, startLine ?? null, endLine ?? null, contentHash ?? null]
      );
      const chunkId = Number(
        db.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!.id
      );
      db.run(
        "INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)",
        [chunkId, new Uint8Array(embedding.buffer)]
      );
    }
  });
  tx();
}

export function upsertFile(
  db: Database,
  path: string,
  hash: string,
  chunks: EmbeddedChunk[]
) {
  const fileId = upsertFileStart(db, path, hash);
  insertChunkBatch(db, fileId, chunks, 0);
}

export function removeFile(db: Database, path: string): boolean {
  const existing = getFileByPath(db, path);
  if (!existing) return false;

  const tx = db.transaction(() => {
    const oldChunks = db
      .query<{ id: number }, [number]>("SELECT id FROM chunks WHERE file_id = ?")
      .all(existing.id);
    for (const c of oldChunks) {
      db.run("DELETE FROM vec_chunks WHERE chunk_id = ?", [c.id]);
    }
    db.run("DELETE FROM chunks WHERE file_id = ?", [existing.id]);
    db.run("DELETE FROM files WHERE id = ?", [existing.id]);
  });

  tx();
  return true;
}

export function pruneDeleted(db: Database, existingPaths: Set<string>): number {
  const allFiles = db
    .query<{ id: number; path: string }, []>("SELECT id, path FROM files")
    .all();

  const toRemove = allFiles.filter(f => !existingPaths.has(f.path));
  if (toRemove.length === 0) return 0;

  const tx = db.transaction(() => {
    for (const file of toRemove) {
      const oldChunks = db
        .query<{ id: number }, [number]>("SELECT id FROM chunks WHERE file_id = ?")
        .all(file.id);
      for (const c of oldChunks) {
        db.run("DELETE FROM vec_chunks WHERE chunk_id = ?", [c.id]);
      }
      db.run("DELETE FROM chunks WHERE file_id = ?", [file.id]);
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
      db.run("DELETE FROM vec_chunks WHERE chunk_id = ?", [c.id]);
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
