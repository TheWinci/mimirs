import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { getEmbeddingDim } from "../embeddings/embed";
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
} from "./types";

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

  constructor(projectDir: string, customRagDir?: string) {
    loadCustomSQLite();

    const ragDir = customRagDir
      ? resolve(customRagDir)
      : process.env.RAG_DB_DIR
        ? resolve(process.env.RAG_DB_DIR)
        : join(projectDir, ".rag");

    try {
      mkdirSync(ragDir, { recursive: true });
    } catch (err: unknown) {
      const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
      if (code === "EROFS" || code === "EACCES") {
        const where = process.env.RAG_DB_DIR
          ? `RAG_DB_DIR path "${ragDir}"`
          : `project directory "${projectDir}"`;
        throw new Error(
          `local-rag: cannot write to ${where} (${code}).\n` +
          `Set RAG_DB_DIR to a writable directory in your MCP server config:\n` +
          `  "env": { "RAG_DB_DIR": "/tmp/my-project-rag", "RAG_PROJECT_DIR": "..." }`
        );
      }
      throw err;
    }

    this.db = new Database(join(ragDir, "index.db"));
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    sqliteVec.load(this.db);
    this.initSchema();
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
        content_hash TEXT
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
        chunk_id INTEGER PRIMARY KEY,
        embedding FLOAT[${getEmbeddingDim()}]
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS fts_chunks USING fts5(
        snippet,
        content='chunks',
        content_rowid='id'
      );

      CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
        INSERT INTO fts_chunks(rowid, snippet) VALUES (new.id, new.snippet);
      END;
      CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
        INSERT INTO fts_chunks(fts_chunks, rowid, snippet) VALUES ('delete', old.id, old.snippet);
      END;
      CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
        INSERT INTO fts_chunks(fts_chunks, rowid, snippet) VALUES ('delete', old.id, old.snippet);
        INSERT INTO fts_chunks(rowid, snippet) VALUES (new.id, new.snippet);
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
        tags TEXT,
        embedding BLOB
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

  private migrateParentChunkColumns() {
    const cols = this.db
      .query<{ name: string }, []>("PRAGMA table_info(chunks)")
      .all()
      .map((c) => c.name);

    if (!cols.includes("parent_id")) {
      this.db.exec("ALTER TABLE chunks ADD COLUMN parent_id INTEGER REFERENCES chunks(id) ON DELETE CASCADE");
    }
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
  upsertFileStart(path: string, hash: string) {
    return fileOps.upsertFileStart(this.db, path, hash);
  }
  updateFileHash(fileId: number, hash: string) {
    fileOps.updateFileHash(this.db, fileId, hash);
  }
  insertChunkBatch(fileId: number, chunks: EmbeddedChunk[], startIndex: number) {
    fileOps.insertChunkBatch(this.db, fileId, chunks, startIndex);
  }
  insertChunkReturningId(fileId: number, chunk: EmbeddedChunk, chunkIndex: number) {
    return fileOps.insertChunkReturningId(this.db, fileId, chunk, chunkIndex);
  }
  getChunkById(chunkId: number) {
    return fileOps.getChunkById(this.db, chunkId);
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

  search(queryEmbedding: Float32Array, topK?: number) {
    return searchOps.vectorSearch(this.db, queryEmbedding, topK);
  }
  textSearch(query: string, topK?: number) {
    return searchOps.textSearch(this.db, query, topK);
  }
  searchChunks(queryEmbedding: Float32Array, topK?: number) {
    return searchOps.vectorSearchChunks(this.db, queryEmbedding, topK);
  }
  textSearchChunks(query: string, topK?: number) {
    return searchOps.textSearchChunks(this.db, query, topK);
  }
  searchSymbols(query: string, exact?: boolean, type?: string, topK?: number) {
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
  getAnnotations(path?: string, symbolName?: string | null) {
    return annotationOps.getAnnotations(this.db, path, symbolName);
  }
  searchAnnotations(queryEmbedding: Float32Array, topK?: number) {
    return annotationOps.searchAnnotations(this.db, queryEmbedding, topK);
  }
  deleteAnnotation(id: number) {
    return annotationOps.deleteAnnotation(this.db, id);
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
