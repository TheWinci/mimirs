import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { getEmbeddingDim } from "../embeddings/embed";
import { identifierParts } from "../indexing/identifiers";
import { applyEmbeddingConfigFromDisk } from "../config";
import { join, resolve } from "path";
import { mkdirSync, existsSync } from "fs";
import { platform } from "os";
import { type EmbeddedChunk } from "../types";

// Store modules
import * as fileOps from "./files";
import * as searchOps from "./search";
import * as graphOps from "./graph";
import * as conversationOps from "./conversation";
import * as checkpointOps from "./checkpoints";
import * as annotationOps from "./annotations";
import * as analyticsOps from "./analytics";
import * as gitHistoryOps from "./git-history";

// Re-export all types so consumers keep importing from "../db"
export type {
  StoredChunk,
  StoredFile,
  SearchResult,
  ChunkSearchResult,
  UsageResult,
  AnnotationRow,
  SymbolResult,
  CheckpointRow,
  ConversationSearchResult,
  GitCommitRow,
  GitCommitSearchResult,
  PathFilter,
} from "./types";

import type { PathFilter } from "./types";

// macOS ships with Apple's SQLite which doesn't support extensions.
// Point bun:sqlite at a vanilla build that supports loadable extensions.
let sqliteLoaded = false;
function loadCustomSQLite() {
  if (sqliteLoaded) return;
  sqliteLoaded = true;

  if (platform() === "darwin") {
    const macPaths = [
      "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib", // Homebrew Apple Silicon
      "/usr/local/opt/sqlite/lib/libsqlite3.dylib",    // Homebrew Intel Mac
    ];
    for (const p of macPaths) {
      if (existsSync(p)) {
        Database.setCustomSQLite(p);
        return;
      }
    }
    throw new Error(
      "sqlite-vec requires vanilla SQLite on macOS.\n" +
      "Apple's bundled SQLite doesn't support extensions.\n" +
      "Fix: brew install sqlite\n" +
      "Then restart your editor."
    );
  }

  if (platform() === "linux") {
    // Most Linux distros ship extension-capable SQLite, but check common paths
    // in case bun:sqlite's bundled version doesn't support extensions.
    const linuxPaths = [
      "/usr/lib/x86_64-linux-gnu/libsqlite3.so.0",  // Debian/Ubuntu x86_64
      "/usr/lib/aarch64-linux-gnu/libsqlite3.so.0",  // Debian/Ubuntu arm64
      "/usr/lib64/libsqlite3.so.0",                   // RHEL/Fedora
      "/usr/lib/libsqlite3.so.0",                     // Arch/Alpine
    ];
    for (const p of linuxPaths) {
      if (existsSync(p)) {
        try {
          Database.setCustomSQLite(p);
          return;
        } catch {
          // If it fails, try next path or fall through to use built-in
        }
      }
    }
    // On Linux, bun's built-in SQLite usually supports extensions — don't throw,
    // let sqlite-vec.load() fail with a specific error if it doesn't work.
  }

  // Windows and other platforms: rely on bun's built-in SQLite
}

export class RagDB {
  private db: Database;
  private ragDir: string;

  constructor(
    projectDir: string,
    customRagDir?: string,
    opts?: { autoEmbeddingConfig?: boolean },
  ) {
    loadCustomSQLite();

    const ragDir = customRagDir
      ? resolve(customRagDir)
      : process.env.RAG_DB_DIR
        ? resolve(process.env.RAG_DB_DIR)
        : join(projectDir, ".mimirs");
    this.ragDir = ragDir;

    try {
      mkdirSync(ragDir, { recursive: true });
    } catch (err: unknown) {
      const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
      if (code === "EROFS" || code === "EACCES") {
        const where = process.env.RAG_DB_DIR
          ? `RAG_DB_DIR path "${ragDir}"`
          : `project directory "${projectDir}"`;
        throw new Error(
          `mimirs: cannot write to ${where} (${code}).\n` +
          `Set RAG_DB_DIR to a writable directory in your MCP server config:\n` +
          `  "env": { "RAG_DB_DIR": "/tmp/my-project-rag", "RAG_PROJECT_DIR": "..." }`
        );
      }
      throw err;
    }

    // Apply the project's embedding model/dim BEFORE initSchema so the vec
    // tables are created at the configured dimension, not the default 384.
    // This makes a correctly-sized index correct-by-construction regardless of
    // call-site ordering. benchmark-models opts out — it drives the embedder
    // itself across multiple models against throwaway indexes.
    if (opts?.autoEmbeddingConfig !== false) {
      applyEmbeddingConfigFromDisk(projectDir);
    }

    this.db = new Database(join(ragDir, "index.db"));
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    sqliteVec.load(this.db);
    this.assertEmbeddingDimCompatible();
    this.initSchema();
  }

  /**
   * Guard against a config/index embedding-dim mismatch. If this DB already has
   * a `vec_chunks` table built at a different dimension than the currently
   * configured model produces, fail loudly here instead of much later with a
   * cryptic vec0 insert error. The stored index wins — the fix is to rebuild or
   * restore the previous embedding config, never to silently re-create tables.
   */
  private assertEmbeddingDimCompatible(): void {
    const row = this.db
      .query<{ sql: string | null }, []>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'vec_chunks'",
      )
      .get();
    if (!row?.sql) return; // fresh DB — vec_chunks will be created at the right dim
    const match = row.sql.match(/FLOAT\s*\[\s*(\d+)\s*\]/i);
    if (!match) return;
    const existingDim = parseInt(match[1], 10);
    const configuredDim = getEmbeddingDim();
    if (existingDim !== configuredDim) {
      throw new Error(
        `mimirs: embedding dimension mismatch — the index at "${this.ragDir}" was ` +
        `built with ${existingDim}-dim vectors, but the configured embedding model ` +
        `produces ${configuredDim}-dim vectors. Restore the previous embeddingModel/` +
        `embeddingDim in .mimirs/config.json, or delete the index to rebuild it.`,
      );
    }
  }

  private initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT UNIQUE NOT NULL,
        hash TEXT NOT NULL,
        indexed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL,
        snippet TEXT NOT NULL,
        entity_name TEXT,
        chunk_type TEXT,
        start_line INTEGER,
        end_line INTEGER,
        content_hash TEXT,
        parts TEXT
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
        chunk_id INTEGER PRIMARY KEY,
        embedding FLOAT[${getEmbeddingDim()}]
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS fts_chunks USING fts5(
        snippet,
        parts,
        content='chunks',
        content_rowid='id'
      );

      CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
        INSERT INTO fts_chunks(rowid, snippet, parts) VALUES (new.id, new.snippet, new.parts);
      END;
      CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
        INSERT INTO fts_chunks(fts_chunks, rowid, snippet, parts) VALUES ('delete', old.id, old.snippet, old.parts);
      END;
      CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
        INSERT INTO fts_chunks(fts_chunks, rowid, snippet, parts) VALUES ('delete', old.id, old.snippet, old.parts);
        INSERT INTO fts_chunks(rowid, snippet, parts) VALUES (new.id, new.snippet, new.parts);
      END;

      -- vec_chunks is a vec0 virtual table, so it can't be an FK child and a
      -- cascade can never reach it. Mirror the fts triggers: whenever a chunk
      -- row is deleted (directly or via any deletion path), drop its vector.
      -- Keeps vec_chunks in sync from one place instead of every caller
      -- remembering a manual delete.
      CREATE TRIGGER IF NOT EXISTS chunks_vec_ad AFTER DELETE ON chunks BEGIN
        DELETE FROM vec_chunks WHERE chunk_id = old.id;
      END;

      CREATE TABLE IF NOT EXISTS file_imports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        names TEXT NOT NULL,
        resolved_file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
        is_default INTEGER DEFAULT 0,
        is_namespace INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS file_exports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        is_default INTEGER DEFAULT 0,
        is_reexport INTEGER DEFAULT 0,
        reexport_source TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_file_imports_file ON file_imports(file_id);
      CREATE INDEX IF NOT EXISTS idx_file_imports_resolved ON file_imports(resolved_file_id);
      CREATE INDEX IF NOT EXISTS idx_file_exports_file ON file_exports(file_id);
      CREATE INDEX IF NOT EXISTS idx_file_exports_name ON file_exports(name);
      CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_id);

      CREATE TABLE IF NOT EXISTS symbol_refs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chunk_id INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        line INTEGER NOT NULL,
        resolved_export_id INTEGER REFERENCES file_exports(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_symbol_refs_chunk ON symbol_refs(chunk_id);
      CREATE INDEX IF NOT EXISTS idx_symbol_refs_file ON symbol_refs(file_id);
      CREATE INDEX IF NOT EXISTS idx_symbol_refs_name ON symbol_refs(name);
      CREATE INDEX IF NOT EXISTS idx_symbol_refs_resolved ON symbol_refs(resolved_export_id);

      CREATE TABLE IF NOT EXISTS conversation_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT UNIQUE NOT NULL,
        jsonl_path TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        turn_count INTEGER DEFAULT 0,
        total_tokens INTEGER DEFAULT 0,
        indexed_at TEXT NOT NULL,
        file_mtime REAL NOT NULL,
        read_offset INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS conversation_turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        turn_index INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        user_text TEXT,
        assistant_text TEXT,
        tools_used TEXT,
        files_referenced TEXT,
        token_cost INTEGER DEFAULT 0,
        summary TEXT,
        UNIQUE(session_id, turn_index)
      );

      CREATE TABLE IF NOT EXISTS conversation_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        turn_id INTEGER NOT NULL REFERENCES conversation_turns(id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL,
        snippet TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS vec_conversation USING vec0(
        chunk_id INTEGER PRIMARY KEY,
        embedding FLOAT[${getEmbeddingDim()}]
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS fts_conversation USING fts5(
        snippet,
        content='conversation_chunks',
        content_rowid='id'
      );

      CREATE TRIGGER IF NOT EXISTS conv_chunks_ai AFTER INSERT ON conversation_chunks BEGIN
        INSERT INTO fts_conversation(rowid, snippet) VALUES (new.id, new.snippet);
      END;
      CREATE TRIGGER IF NOT EXISTS conv_chunks_ad AFTER DELETE ON conversation_chunks BEGIN
        INSERT INTO fts_conversation(fts_conversation, rowid, snippet) VALUES ('delete', old.id, old.snippet);
      END;
      CREATE TRIGGER IF NOT EXISTS conv_chunks_au AFTER UPDATE ON conversation_chunks BEGIN
        INSERT INTO fts_conversation(fts_conversation, rowid, snippet) VALUES ('delete', old.id, old.snippet);
        INSERT INTO fts_conversation(rowid, snippet) VALUES (new.id, new.snippet);
      END;

      CREATE INDEX IF NOT EXISTS idx_conv_turns_session ON conversation_turns(session_id);

      CREATE TABLE IF NOT EXISTS conversation_checkpoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        turn_index INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        files_involved TEXT,
        tags TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_checkpoints_session ON conversation_checkpoints(session_id);
      CREATE INDEX IF NOT EXISTS idx_checkpoints_type ON conversation_checkpoints(type);

      CREATE VIRTUAL TABLE IF NOT EXISTS vec_checkpoints USING vec0(
        checkpoint_id INTEGER PRIMARY KEY,
        embedding FLOAT[${getEmbeddingDim()}]
      );

      CREATE TABLE IF NOT EXISTS query_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        query TEXT NOT NULL,
        result_count INTEGER NOT NULL,
        top_score REAL,
        top_path TEXT,
        duration_ms INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS git_commits (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        hash        TEXT UNIQUE NOT NULL,
        short_hash  TEXT NOT NULL,
        message     TEXT NOT NULL,
        author_name TEXT NOT NULL,
        author_email TEXT NOT NULL,
        date        TEXT NOT NULL,
        files_changed TEXT NOT NULL,
        insertions  INTEGER DEFAULT 0,
        deletions   INTEGER DEFAULT 0,
        is_merge    INTEGER DEFAULT 0,
        refs        TEXT,
        diff_summary TEXT,
        indexed_at  TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS git_commit_files (
        commit_id   INTEGER NOT NULL REFERENCES git_commits(id) ON DELETE CASCADE,
        file_path   TEXT NOT NULL,
        insertions  INTEGER DEFAULT 0,
        deletions   INTEGER DEFAULT 0,
        PRIMARY KEY (commit_id, file_path)
      );
      CREATE INDEX IF NOT EXISTS idx_gcf_path ON git_commit_files(file_path);

      CREATE VIRTUAL TABLE IF NOT EXISTS vec_git_commits USING vec0(
        commit_id INTEGER PRIMARY KEY,
        embedding FLOAT[${getEmbeddingDim()}]
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS fts_git_commits USING fts5(
        message,
        diff_summary,
        content='git_commits',
        content_rowid='id'
      );

      CREATE TRIGGER IF NOT EXISTS git_commits_ai AFTER INSERT ON git_commits BEGIN
        INSERT INTO fts_git_commits(rowid, message, diff_summary)
        VALUES (new.id, new.message, new.diff_summary);
      END;
      CREATE TRIGGER IF NOT EXISTS git_commits_ad AFTER DELETE ON git_commits BEGIN
        INSERT INTO fts_git_commits(fts_git_commits, rowid, message, diff_summary)
        VALUES ('delete', old.id, old.message, old.diff_summary);
      END;
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS annotations (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        path        TEXT NOT NULL,
        symbol_name TEXT,
        note        TEXT NOT NULL,
        author      TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ann_path ON annotations(path);

      CREATE VIRTUAL TABLE IF NOT EXISTS fts_annotations USING fts5(
        note,
        content='annotations',
        content_rowid='id'
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS vec_annotations USING vec0(
        annotation_id INTEGER PRIMARY KEY,
        embedding FLOAT[${getEmbeddingDim()}]
      );
    `);

    this.migrateChunksEntityColumns();
    this.migrateParentChunkColumns();
    this.migrateGraphColumns();
    this.migrateSearchPartsColumn();
    this.dedupeChunks();
    this.backfillMissingSymbolRefs();
  }

  /**
   * One-time recovery for DBs indexed before the `symbol_refs` feature
   * shipped (April 2026). Those files have chunks + `file_imports` but
   * zero `symbol_refs` rows — the trace walker can't follow callees out
   * of them. Clear `files.hash` so the next indexing pass re-emits chunks
   * with the per-chunk `references` map bun-chunk now provides.
   *
   * Detected per-file: a file has imports (`file_imports.resolved_file_id`
   * non-null on at least one row) but zero `symbol_refs`. Files with zero
   * imports legitimately have no internal callees and stay alone.
   */
  private backfillMissingSymbolRefs() {
    const stale = this.db
      .query<{ file_id: number }, []>(
        `SELECT DISTINCT fi.file_id
         FROM file_imports fi
         WHERE fi.resolved_file_id IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM symbol_refs sr WHERE sr.file_id = fi.file_id
           )`,
      )
      .all();
    if (stale.length === 0) return;

    const tx = this.db.transaction(() => {
      for (const r of stale) {
        this.db.run("UPDATE files SET hash = '' WHERE id = ?", [r.file_id]);
      }
    });
    tx();
  }

  /**
   * One-time recovery: pre-fix DBs accumulated 2× (sometimes more) chunk rows
   * for files that were re-indexed by two mimirs processes concurrently
   * (e.g. one MCP server per IDE window). Collapse duplicates by
   * `(file_id, chunk_index, content_hash)`.
   *
   * `symbol_refs` rows on the dropped-side chunks would cascade-delete, but
   * the surviving chunks' refs are also wrong: every `upsertSymbolRefs`
   * call clears the file's refs and re-inserts, so only the last-writer's
   * refs are still in the table — and they point at chunk ids we may have
   * just deleted. Cleanest recovery is to clear the file's `hash` so the
   * next indexing pass re-emits chunks + refs cleanly.
   */
  private dedupeChunks() {
    const dupGroups = this.db
      .query<{ n: number }, []>(
        `SELECT COUNT(*) AS n FROM (
           SELECT 1 FROM chunks
           WHERE content_hash IS NOT NULL
           GROUP BY file_id, chunk_index, content_hash
           HAVING COUNT(*) > 1
         )`,
      )
      .get();
    if (!dupGroups || dupGroups.n === 0) return;

    this.db.transaction(() => {
      const affectedFiles = this.db
        .query<{ file_id: number }, []>(
          `SELECT DISTINCT file_id FROM chunks
           WHERE content_hash IS NOT NULL
           GROUP BY file_id, chunk_index, content_hash
           HAVING COUNT(*) > 1`,
        )
        .all();

      this.db.exec(`
        DELETE FROM chunks
        WHERE id NOT IN (
          SELECT MIN(id) FROM chunks
          WHERE content_hash IS NOT NULL
          GROUP BY file_id, chunk_index, content_hash
        )
        AND content_hash IS NOT NULL
        AND id IN (
          SELECT id FROM chunks
          WHERE content_hash IS NOT NULL
          AND (file_id, chunk_index, content_hash) IN (
            SELECT file_id, chunk_index, content_hash FROM chunks
            WHERE content_hash IS NOT NULL
            GROUP BY file_id, chunk_index, content_hash
            HAVING COUNT(*) > 1
          )
        )
      `);

      // Force re-index of affected files — their symbol_refs are stale
      // (point at chunk ids that may have just been deleted, or were
      // last-writer-wins from the racing process and never matched the
      // surviving chunks).
      for (const f of affectedFiles) {
        this.db.run("UPDATE files SET hash = '' WHERE id = ?", [f.file_id]);
      }
    })();
  }

  private migrateChunksEntityColumns() {
    const cols = this.db
      .query<{ name: string }, []>("PRAGMA table_info(chunks)")
      .all()
      .map((c) => c.name);

    if (!cols.includes("entity_name")) {
      this.db.exec("ALTER TABLE chunks ADD COLUMN entity_name TEXT");
    }
    if (!cols.includes("chunk_type")) {
      this.db.exec("ALTER TABLE chunks ADD COLUMN chunk_type TEXT");
    }
    if (!cols.includes("start_line")) {
      this.db.exec("ALTER TABLE chunks ADD COLUMN start_line INTEGER");
    }
    if (!cols.includes("end_line")) {
      this.db.exec("ALTER TABLE chunks ADD COLUMN end_line INTEGER");
    }
    if (!cols.includes("content_hash")) {
      this.db.exec("ALTER TABLE chunks ADD COLUMN content_hash TEXT");
    }
  }

  // Identifier-aware FTS: add a `parts` column holding split identifier words and
  // rebuild fts_chunks to index (snippet, parts) so `depends` matches `getDependsOn`.
  // Existing indexes are migrated in place (recreate FTS + backfill parts, which
  // repopulates the index via the update trigger) — no re-embed needed.
  private migrateSearchPartsColumn() {
    const cols = this.db
      .query<{ name: string }, []>("PRAGMA table_info(chunks)")
      .all()
      .map((c) => c.name);
    if (!cols.includes("parts")) {
      this.db.exec("ALTER TABLE chunks ADD COLUMN parts TEXT");
    }

    const ftsSql =
      this.db.query<{ sql: string | null }, []>("SELECT sql FROM sqlite_master WHERE name = 'fts_chunks'").get()?.sql ?? "";
    if (ftsSql.includes("parts")) return; // already migrated (or fresh DB created with the new schema)

    // Drop the old FTS + triggers FIRST, so backfilling `parts` doesn't fire a
    // trigger that issues a 'delete' against a half-built external-content index
    // (which raises SQLITE_CORRUPT_VTAB).
    this.db.exec(`
      DROP TRIGGER IF EXISTS chunks_ai;
      DROP TRIGGER IF EXISTS chunks_ad;
      DROP TRIGGER IF EXISTS chunks_au;
      DROP TABLE IF EXISTS fts_chunks;
    `);

    // Backfill parts for existing rows with NO triggers active.
    const rows = this.db.query<{ id: number; snippet: string }, []>("SELECT id, snippet FROM chunks").all();
    if (rows.length > 0) {
      const upd = this.db.prepare("UPDATE chunks SET parts = ? WHERE id = ?");
      const tx = this.db.transaction(() => {
        for (const r of rows) upd.run(identifierParts(r.snippet), r.id);
      });
      tx();
    }

    // Recreate the FTS over (snippet, parts) + triggers, then populate the whole
    // index from the content table via FTS5 'rebuild' (the correct way to seed an
    // external-content table — no per-row 'delete' of absent rows).
    this.db.exec(`
      CREATE VIRTUAL TABLE fts_chunks USING fts5(snippet, parts, content='chunks', content_rowid='id');
      CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
        INSERT INTO fts_chunks(rowid, snippet, parts) VALUES (new.id, new.snippet, new.parts);
      END;
      CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
        INSERT INTO fts_chunks(fts_chunks, rowid, snippet, parts) VALUES ('delete', old.id, old.snippet, old.parts);
      END;
      CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN
        INSERT INTO fts_chunks(fts_chunks, rowid, snippet, parts) VALUES ('delete', old.id, old.snippet, old.parts);
        INSERT INTO fts_chunks(rowid, snippet, parts) VALUES (new.id, new.snippet, new.parts);
      END;
      INSERT INTO fts_chunks(fts_chunks) VALUES('rebuild');
    `);
  }

  private migrateParentChunkColumns() {
    const cols = this.db
      .query<{ name: string }, []>("PRAGMA table_info(chunks)")
      .all()
      .map((c) => c.name);

    if (!cols.includes("parent_id")) {
      this.db.exec("ALTER TABLE chunks ADD COLUMN parent_id INTEGER REFERENCES chunks(id) ON DELETE CASCADE");
    }
    // Created here (not in initSchema) because parent_id is added via ALTER TABLE
    // for existing DBs, so this is the earliest point it's guaranteed to exist.
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_chunks_parent ON chunks(parent_id)");
  }

  private migrateGraphColumns() {
    const importCols = this.db
      .query<{ name: string }, []>("PRAGMA table_info(file_imports)")
      .all()
      .map((c) => c.name);

    if (!importCols.includes("is_default")) {
      this.db.exec("ALTER TABLE file_imports ADD COLUMN is_default INTEGER DEFAULT 0");
    }
    if (!importCols.includes("is_namespace")) {
      this.db.exec("ALTER TABLE file_imports ADD COLUMN is_namespace INTEGER DEFAULT 0");
    }

    const exportCols = this.db
      .query<{ name: string }, []>("PRAGMA table_info(file_exports)")
      .all()
      .map((c) => c.name);

    if (!exportCols.includes("is_default")) {
      this.db.exec("ALTER TABLE file_exports ADD COLUMN is_default INTEGER DEFAULT 0");
    }
    if (!exportCols.includes("is_reexport")) {
      this.db.exec("ALTER TABLE file_exports ADD COLUMN is_reexport INTEGER DEFAULT 0");
    }
    if (!exportCols.includes("reexport_source")) {
      this.db.exec("ALTER TABLE file_exports ADD COLUMN reexport_source TEXT");
    }
  }

  // ── File operations ───────────────────────────────────────────

  getFileByPath(path: string) {
    return fileOps.getFileByPath(this.db, path);
  }
  getFilesByPaths(paths: string[]) {
    return fileOps.getFilesByPaths(this.db, paths);
  }
  upsertFileStart(path: string, hash: string) {
    return fileOps.upsertFileStart(this.db, path, hash);
  }
  updateFileHash(fileId: number, hash: string) {
    fileOps.updateFileHash(this.db, fileId, hash);
  }
  insertChunkBatch(fileId: number, chunks: EmbeddedChunk[], startIndex: number) {
    return fileOps.insertChunkBatch(this.db, fileId, chunks, startIndex);
  }
  insertChunkReturningId(fileId: number, chunk: EmbeddedChunk, chunkIndex: number) {
    return fileOps.insertChunkReturningId(this.db, fileId, chunk, chunkIndex);
  }
  getChunkById(chunkId: number) {
    return fileOps.getChunkById(this.db, chunkId);
  }
  getFileChunkRanges(filePath: string) {
    return fileOps.getFileChunkRanges(this.db, filePath);
  }
  upsertFile(path: string, hash: string, chunks: EmbeddedChunk[]) {
    fileOps.upsertFile(this.db, path, hash, chunks);
  }
  removeFile(path: string) {
    return fileOps.removeFile(this.db, path);
  }
  pruneDeleted(existingPaths: Set<string>) {
    return fileOps.pruneDeleted(this.db, existingPaths);
  }
  getAllFilePaths() {
    return fileOps.getAllFilePaths(this.db);
  }
  getChunkHashes(fileId: number) {
    return fileOps.getChunkHashes(this.db, fileId);
  }
  getChunkIdsByHash(fileId: number) {
    return fileOps.getChunkIdsByHash(this.db, fileId);
  }
  deleteStaleChunks(fileId: number, keepHashes: Set<string>) {
    return fileOps.deleteStaleChunks(this.db, fileId, keepHashes);
  }
  updateChunkPositions(
    fileId: number,
    updates: { contentHash: string; chunkIndex: number; startLine: number | null; endLine: number | null }[]
  ) {
    fileOps.updateChunkPositions(this.db, fileId, updates);
  }
  getStatus() {
    return fileOps.getStatus(this.db);
  }

  // ── Search operations ─────────────────────────────────────────

  search(queryEmbedding: Float32Array, topK?: number, filter?: PathFilter) {
    return searchOps.vectorSearch(this.db, queryEmbedding, topK, filter);
  }
  textSearch(query: string, topK?: number, filter?: PathFilter) {
    return searchOps.textSearch(this.db, query, topK, filter);
  }
  searchChunks(queryEmbedding: Float32Array, topK?: number, filter?: PathFilter) {
    return searchOps.vectorSearchChunks(this.db, queryEmbedding, topK, filter);
  }
  textSearchChunks(query: string, topK?: number, filter?: PathFilter) {
    return searchOps.textSearchChunks(this.db, query, topK, filter);
  }
  searchSymbols(query?: string, exact?: boolean, type?: string, topK?: number) {
    return searchOps.searchSymbols(this.db, query, exact, type, topK);
  }
  findUsages(symbolName: string, exact: boolean, top: number) {
    return searchOps.findUsages(this.db, symbolName, exact, top);
  }

  // ── Graph operations ──────────────────────────────────────────

  upsertFileGraph(
    fileId: number,
    imports: { name: string; source: string; isDefault?: boolean; isNamespace?: boolean }[],
    exports: { name: string; type: string; isDefault?: boolean; isReExport?: boolean; reExportSource?: string }[]
  ) {
    graphOps.upsertFileGraph(this.db, fileId, imports, exports);
  }
  upsertSymbolRefs(
    fileId: number,
    refs: { chunkId: number; name: string; line: number }[]
  ) {
    graphOps.upsertSymbolRefs(this.db, fileId, refs);
  }
  resolveSymbolRefs(fileId: number) {
    graphOps.resolveSymbolRefs(this.db, fileId);
  }
  resolveAllSymbolRefs() {
    graphOps.resolveAllSymbolRefs(this.db);
  }
  getCallableExports() {
    return graphOps.getCallableExports(this.db);
  }
  countInboundRefsByExport(excludeFileIds: Set<number>) {
    return graphOps.countInboundRefsByExport(this.db, excludeFileIds);
  }
  getCalleeRefsForExport(exportId: number) {
    return graphOps.getCalleeRefsForExport(this.db, exportId);
  }
  getCalleeRefsForLocalSymbol(fileId: number, name: string) {
    return graphOps.getCalleeRefsForLocalSymbol(this.db, fileId, name);
  }
  getCallersOfExport(exportId: number) {
    return graphOps.getCallersOfExport(this.db, exportId);
  }
  getCallersOfLocalSymbol(fileId: number, name: string) {
    return graphOps.getCallersOfLocalSymbol(this.db, fileId, name);
  }
  getCallablesByName(name: string) {
    return graphOps.getCallablesByName(this.db, name);
  }
  getLocalCallable(fileId: number, name: string) {
    return graphOps.getLocalCallable(this.db, fileId, name);
  }
  getUniqueLocalCallableBySuffix(suffix: string) {
    return graphOps.getUniqueLocalCallableBySuffix(this.db, suffix);
  }
  getCallableRange(fileId: number, symbol: string) {
    return graphOps.getCallableRange(this.db, fileId, symbol);
  }
  getSymbolRefsInRange(fileId: number, startLine: number, endLine: number) {
    return graphOps.getSymbolRefsInRange(this.db, fileId, startLine, endLine);
  }
  getContainingChunk(fileId: number, line: number) {
    return graphOps.getContainingChunk(this.db, fileId, line);
  }
  getSymbolReferencesByName(names: string[], filePaths?: string[]) {
    return graphOps.getSymbolReferencesByName(this.db, names, filePaths);
  }
  getProjectRefFanIn() {
    return graphOps.getProjectRefFanIn(this.db);
  }
  resolveImport(importId: number, resolvedFileId: number) {
    graphOps.resolveImport(this.db, importId, resolvedFileId);
  }
  getUnresolvedImports() {
    return graphOps.getUnresolvedImports(this.db);
  }
  getGraph() {
    return graphOps.getGraph(this.db);
  }
  getSubgraph(fileIds: number[], maxHops?: number) {
    return graphOps.getSubgraph(this.db, fileIds, maxHops);
  }
  getImportsForFile(fileId: number) {
    return graphOps.getImportsForFile(this.db, fileId);
  }
  getImportersOf(fileId: number) {
    return graphOps.getImportersOf(this.db, fileId);
  }
  getDependsOn(fileId: number) {
    return graphOps.getDependsOn(this.db, fileId);
  }
  getDependedOnBy(fileId: number) {
    return graphOps.getDependedOnBy(this.db, fileId);
  }
  getDependsOnForFiles(fileIds: number[]) {
    return graphOps.getDependsOnForFiles(this.db, fileIds);
  }
  getDependedOnByForFiles(fileIds: number[]) {
    return graphOps.getDependedOnByForFiles(this.db, fileIds);
  }
  getSymbolGraphData() {
    return graphOps.getSymbolGraphData(this.db);
  }
  getProjectConstants() {
    return graphOps.getProjectConstants(this.db);
  }

  // ── Conversation operations ───────────────────────────────────

  upsertSession(
    sessionId: string, jsonlPath: string, startedAt: string,
    mtime: number, readOffset: number
  ) {
    conversationOps.upsertSession(this.db, sessionId, jsonlPath, startedAt, mtime, readOffset);
  }
  getSession(sessionId: string) {
    return conversationOps.getSession(this.db, sessionId);
  }
  updateSessionStats(
    sessionId: string, turnCount: number, totalTokens: number, readOffset: number
  ) {
    conversationOps.updateSessionStats(this.db, sessionId, turnCount, totalTokens, readOffset);
  }
  insertTurn(
    sessionId: string, turnIndex: number, timestamp: string,
    userText: string, assistantText: string, toolsUsed: string[],
    filesReferenced: string[], tokenCost: number, summary: string,
    chunks: { snippet: string; embedding: Float32Array }[]
  ) {
    return conversationOps.insertTurn(
      this.db, sessionId, turnIndex, timestamp, userText,
      assistantText, toolsUsed, filesReferenced, tokenCost, summary, chunks
    );
  }
  getTurnCount(sessionId: string) {
    return conversationOps.getTurnCount(this.db, sessionId);
  }
  searchConversation(queryEmbedding: Float32Array, topK?: number, sessionId?: string) {
    return conversationOps.searchConversation(this.db, queryEmbedding, topK, sessionId);
  }
  textSearchConversation(query: string, topK?: number, sessionId?: string) {
    return conversationOps.textSearchConversation(this.db, query, topK, sessionId);
  }

  // ── Checkpoint operations ─────────────────────────────────────

  createCheckpoint(
    sessionId: string, turnIndex: number, timestamp: string,
    type: string, title: string, summary: string,
    filesInvolved: string[], tags: string[], embedding: Float32Array
  ) {
    return checkpointOps.createCheckpoint(
      this.db, sessionId, turnIndex, timestamp, type, title,
      summary, filesInvolved, tags, embedding
    );
  }
  listCheckpoints(sessionId?: string, type?: string, limit?: number) {
    return checkpointOps.listCheckpoints(this.db, sessionId, type, limit);
  }
  searchCheckpoints(queryEmbedding: Float32Array, topK?: number, type?: string) {
    return checkpointOps.searchCheckpoints(this.db, queryEmbedding, topK, type);
  }
  getCheckpoint(id: number) {
    return checkpointOps.getCheckpoint(this.db, id);
  }

  // ── Annotation operations ─────────────────────────────────────

  upsertAnnotation(
    path: string, note: string, embedding: Float32Array,
    symbolName?: string | null, author?: string | null
  ) {
    return annotationOps.upsertAnnotation(this.db, path, note, embedding, symbolName, author);
  }
  getAnnotationsForPaths(paths: string[]) {
    return annotationOps.getAnnotationsForPaths(this.db, paths);
  }
  getAnnotations(path?: string, symbolName?: string | null) {
    return annotationOps.getAnnotations(this.db, path, symbolName);
  }
  searchAnnotations(queryEmbedding: Float32Array, topK?: number) {
    return annotationOps.searchAnnotations(this.db, queryEmbedding, topK);
  }
  deleteAnnotation(id: number) {
    return annotationOps.deleteAnnotation(this.db, id);
  }

  // ── Git history operations ────────────────────────────────────

  insertCommitBatch(commits: gitHistoryOps.GitCommitInsert[]) {
    gitHistoryOps.insertCommitBatch(this.db, commits);
  }
  getLastIndexedCommit() {
    return gitHistoryOps.getLastIndexedCommit(this.db);
  }
  hasCommit(hash: string) {
    return gitHistoryOps.hasCommit(this.db, hash);
  }
  searchGitCommits(queryEmbedding: Float32Array, topK?: number, author?: string, since?: string, until?: string, path?: string) {
    return gitHistoryOps.searchGitCommits(this.db, queryEmbedding, topK, author, since, until, path);
  }
  textSearchGitCommits(query: string, topK?: number, author?: string, since?: string, until?: string, path?: string) {
    return gitHistoryOps.textSearchGitCommits(this.db, query, topK, author, since, until, path);
  }
  getFileHistory(filePath: string, topK?: number, since?: string) {
    return gitHistoryOps.getFileHistory(this.db, filePath, topK, since);
  }
  getFileHistoryForPaths(filePaths: string[], topK?: number) {
    return gitHistoryOps.getFileHistoryForPaths(this.db, filePaths, topK);
  }
  getAllCommitHashes() {
    return gitHistoryOps.getAllCommitHashes(this.db);
  }
  purgeOrphanedCommits(reachableHashes: Set<string>) {
    return gitHistoryOps.purgeOrphanedCommits(this.db, reachableHashes);
  }
  clearGitHistory() {
    gitHistoryOps.clearGitHistory(this.db);
  }
  getGitHistoryStatus() {
    return gitHistoryOps.getGitHistoryStatus(this.db);
  }

  // ── Analytics operations ──────────────────────────────────────

  logQuery(
    query: string, resultCount: number,
    topScore: number | null, topPath: string | null, durationMs: number
  ) {
    analyticsOps.logQuery(this.db, query, resultCount, topScore, topPath, durationMs);
  }
  getAnalytics(days?: number) {
    return analyticsOps.getAnalytics(this.db, days);
  }
  getAnalyticsTrend(days?: number) {
    return analyticsOps.getAnalyticsTrend(this.db, days);
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  close() {
    this.db.close();
  }
}
