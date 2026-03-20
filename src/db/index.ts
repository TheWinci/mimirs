import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { EMBEDDING_DIM } from "../embeddings/embed";
import { join, resolve } from "path";
import { mkdirSync, existsSync } from "fs";
import { platform } from "os";

// macOS ships with Apple's SQLite which doesn't support extensions.
// Point bun:sqlite at Homebrew's vanilla build if available.
function loadCustomSQLite() {
  if (platform() !== "darwin") return;

  const paths = [
    "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib", // Apple Silicon
    "/usr/local/opt/sqlite/lib/libsqlite3.dylib",    // Intel Mac
  ];

  for (const p of paths) {
    if (existsSync(p)) {
      Database.setCustomSQLite(p);
      return;
    }
  }

  throw new Error(
    "sqlite-vec requires vanilla SQLite on macOS. Install it with: brew install sqlite"
  );
}

loadCustomSQLite();

export interface StoredChunk {
  id: number;
  fileId: number;
  chunkIndex: number;
  snippet: string;
  entityName: string | null;
  chunkType: string | null;
  startLine: number | null;
  endLine: number | null;
}

export interface StoredFile {
  id: number;
  path: string;
  hash: string;
  indexedAt: string;
}

export interface SearchResult {
  path: string;
  score: number;
  snippet: string;
  chunkIndex: number;
  entityName: string | null;
  chunkType: string | null;
}

export interface ChunkSearchResult {
  path: string;
  score: number;
  content: string;
  chunkIndex: number;
  entityName: string | null;
  chunkType: string | null;
  startLine: number | null;
  endLine: number | null;
}

export interface UsageResult {
  path: string;
  line: number | null;
  snippet: string;
}

export interface AnnotationRow {
  id: number;
  path: string;
  symbolName: string | null;
  note: string;
  author: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SymbolResult {
  path: string;
  symbolName: string;
  symbolType: string;
  snippet: string | null;
  chunkIndex: number | null;
}

export interface CheckpointRow {
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

export interface ConversationSearchResult {
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

export class RagDB {
  private db: Database;

  constructor(projectDir: string) {
    // RAG_DB_DIR lets users decouple the index location from the project
    // directory — useful when the project lives on a read-only filesystem.
    const ragDir = process.env.RAG_DB_DIR
      ? resolve(process.env.RAG_DB_DIR)
      : join(projectDir, ".rag");

    try {
      mkdirSync(ragDir, { recursive: true });
    } catch (err: any) {
      if (err.code === "EROFS" || err.code === "EACCES") {
        const where = process.env.RAG_DB_DIR
          ? `RAG_DB_DIR path "${ragDir}"`
          : `project directory "${projectDir}"`;
        throw new Error(
          `local-rag-mcp: cannot write to ${where} (${err.code}).\n` +
          `Set RAG_DB_DIR to a writable directory in your MCP server config:\n` +
          `  "env": { "RAG_DB_DIR": "/tmp/my-project-rag", "RAG_PROJECT_DIR": "..." }`
        );
      }
      throw err;
    }

    this.db = new Database(join(ragDir, "index.db"));
    this.db.exec("PRAGMA journal_mode=WAL");
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
        end_line INTEGER
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
        chunk_id INTEGER PRIMARY KEY,
        embedding FLOAT[${EMBEDDING_DIM}]
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS fts_chunks USING fts5(
        snippet,
        content='chunks',
        content_rowid='id'
      );

      -- Keep FTS in sync with chunks table
      CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
        INSERT INTO fts_chunks(rowid, snippet) VALUES (new.id, new.snippet);
      END;
      CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
        INSERT INTO fts_chunks(fts_chunks, rowid, snippet) VALUES ('delete', old.id, old.snippet);
      END;

      CREATE TABLE IF NOT EXISTS file_imports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        names TEXT NOT NULL,
        resolved_file_id INTEGER REFERENCES files(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS file_exports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        type TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_file_imports_file ON file_imports(file_id);
      CREATE INDEX IF NOT EXISTS idx_file_imports_resolved ON file_imports(resolved_file_id);
      CREATE INDEX IF NOT EXISTS idx_file_exports_file ON file_exports(file_id);
      CREATE INDEX IF NOT EXISTS idx_file_exports_name ON file_exports(name);

      -- Conversation indexing tables
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
        embedding FLOAT[${EMBEDDING_DIM}]
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
        embedding FLOAT[${EMBEDDING_DIM}]
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
      CREATE TABLE IF NOT EXISTS symbol_usages (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        symbol_name TEXT NOT NULL,
        line        INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_usages_symbol ON symbol_usages(symbol_name COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS idx_usages_file ON symbol_usages(file_id);
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
        embedding FLOAT[${EMBEDDING_DIM}]
      );
    `);

    // Migrations for existing databases
    this.migrateChunksEntityColumns();
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
  }

  getFileByPath(path: string): StoredFile | null {
    return this.db
      .query<StoredFile, [string]>("SELECT * FROM files WHERE path = ?")
      .get(path);
  }

  /**
   * Creates the file record and removes old data. Returns the new file ID.
   * Call `insertChunkBatch` in a loop to insert chunks after this.
   */
  upsertFileStart(path: string, hash: string): number {
    // Remove old data if exists
    const existing = this.getFileByPath(path);
    if (existing) {
      const deleteTx = this.db.transaction(() => {
        const oldChunks = this.db
          .query<{ id: number }, [number]>(
            "SELECT id FROM chunks WHERE file_id = ?"
          )
          .all(existing.id);
        for (const c of oldChunks) {
          this.db.run("DELETE FROM vec_chunks WHERE chunk_id = ?", [c.id]);
        }
        this.db.run("DELETE FROM chunks WHERE file_id = ?", [existing.id]);
        this.db.run("DELETE FROM files WHERE id = ?", [existing.id]);
      });
      deleteTx();
    }

    this.db.run(
      "INSERT INTO files (path, hash, indexed_at) VALUES (?, ?, ?)",
      [path, hash, new Date().toISOString()]
    );
    return Number(
      this.db.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!.id
    );
  }

  /**
   * Insert a batch of chunks for a file in a single transaction.
   */
  insertChunkBatch(
    fileId: number,
    chunks: { snippet: string; embedding: Float32Array; entityName?: string | null; chunkType?: string | null; startLine?: number | null; endLine?: number | null }[],
    startIndex: number
  ) {
    const tx = this.db.transaction(() => {
      for (let i = 0; i < chunks.length; i++) {
        const { snippet, embedding, entityName, chunkType, startLine, endLine } = chunks[i];
        this.db.run(
          "INSERT INTO chunks (file_id, chunk_index, snippet, entity_name, chunk_type, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [fileId, startIndex + i, snippet, entityName ?? null, chunkType ?? null, startLine ?? null, endLine ?? null]
        );
        const chunkId = Number(
          this.db.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!.id
        );
        this.db.run(
          "INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)",
          [chunkId, new Uint8Array(embedding.buffer)]
        );
      }
    });
    tx();
  }

  /**
   * Convenience wrapper: upserts file + all chunks in one go (blocks until done).
   */
  upsertFile(
    path: string,
    hash: string,
    chunks: { snippet: string; embedding: Float32Array; entityName?: string | null; chunkType?: string | null; startLine?: number | null; endLine?: number | null }[]
  ) {
    const fileId = this.upsertFileStart(path, hash);
    this.insertChunkBatch(fileId, chunks, 0);
  }

  removeFile(path: string): boolean {
    const existing = this.getFileByPath(path);
    if (!existing) return false;

    const tx = this.db.transaction(() => {
      const oldChunks = this.db
        .query<{ id: number }, [number]>(
          "SELECT id FROM chunks WHERE file_id = ?"
        )
        .all(existing.id);
      for (const c of oldChunks) {
        this.db.run("DELETE FROM vec_chunks WHERE chunk_id = ?", [c.id]);
      }
      this.db.run("DELETE FROM chunks WHERE file_id = ?", [existing.id]);
      this.db.run("DELETE FROM files WHERE id = ?", [existing.id]);
    });

    tx();
    return true;
  }

  search(queryEmbedding: Float32Array, topK: number = 5): SearchResult[] {
    const rows = this.db
      .query<
        { chunk_id: number; distance: number },
        [Uint8Array, number]
      >(
        `SELECT chunk_id, distance
         FROM vec_chunks
         WHERE embedding MATCH ?
         ORDER BY distance
         LIMIT ?`
      )
      .all(new Uint8Array(queryEmbedding.buffer), topK);

    return rows.map((row) => {
      const chunk = this.db
        .query<
          { snippet: string; chunk_index: number; file_id: number; entity_name: string | null; chunk_type: string | null },
          [number]
        >("SELECT snippet, chunk_index, file_id, entity_name, chunk_type FROM chunks WHERE id = ?")
        .get(row.chunk_id)!;
      const file = this.db
        .query<{ path: string }, [number]>(
          "SELECT path FROM files WHERE id = ?"
        )
        .get(chunk.file_id)!;

      // sqlite-vec returns L2 distance; convert to similarity score (0-1)
      const score = 1 / (1 + row.distance);

      return {
        path: file.path,
        score,
        snippet: chunk.snippet,
        chunkIndex: chunk.chunk_index,
        entityName: chunk.entity_name,
        chunkType: chunk.chunk_type,
      };
    });
  }

  textSearch(query: string, topK: number = 5): SearchResult[] {
    // FTS5 bm25() returns negative scores (lower = better match)
    const rows = this.db
      .query<
        { id: number; snippet: string; chunk_index: number; file_id: number; entity_name: string | null; chunk_type: string | null; rank: number },
        [string, number]
      >(
        `SELECT c.id, c.snippet, c.chunk_index, c.file_id, c.entity_name, c.chunk_type, rank
         FROM fts_chunks f
         JOIN chunks c ON c.id = f.rowid
         WHERE fts_chunks MATCH ?
         ORDER BY rank
         LIMIT ?`
      )
      .all(query, topK);

    return rows.map((row) => {
      const file = this.db
        .query<{ path: string }, [number]>(
          "SELECT path FROM files WHERE id = ?"
        )
        .get(row.file_id)!;

      // Convert FTS5 rank to 0-1 score (rank is negative, closer to 0 = better)
      const score = 1 / (1 + Math.abs(row.rank));

      return {
        path: file.path,
        score,
        snippet: row.snippet,
        chunkIndex: row.chunk_index,
        entityName: row.entity_name,
        chunkType: row.chunk_type,
      };
    });
  }

  searchChunks(queryEmbedding: Float32Array, topK: number = 8): ChunkSearchResult[] {
    const rows = this.db
      .query<
        { chunk_id: number; distance: number },
        [Uint8Array, number]
      >(
        `SELECT chunk_id, distance
         FROM vec_chunks
         WHERE embedding MATCH ?
         ORDER BY distance
         LIMIT ?`
      )
      .all(new Uint8Array(queryEmbedding.buffer), topK);

    return rows.map((row) => {
      const chunk = this.db
        .query<
          { snippet: string; chunk_index: number; file_id: number; entity_name: string | null; chunk_type: string | null; start_line: number | null; end_line: number | null },
          [number]
        >("SELECT snippet, chunk_index, file_id, entity_name, chunk_type, start_line, end_line FROM chunks WHERE id = ?")
        .get(row.chunk_id)!;
      const file = this.db
        .query<{ path: string }, [number]>(
          "SELECT path FROM files WHERE id = ?"
        )
        .get(chunk.file_id)!;

      const score = 1 / (1 + row.distance);

      return {
        path: file.path,
        score,
        content: chunk.snippet,
        chunkIndex: chunk.chunk_index,
        entityName: chunk.entity_name,
        chunkType: chunk.chunk_type,
        startLine: chunk.start_line,
        endLine: chunk.end_line,
      };
    });
  }

  textSearchChunks(query: string, topK: number = 8): ChunkSearchResult[] {
    const rows = this.db
      .query<
        { id: number; snippet: string; chunk_index: number; file_id: number; entity_name: string | null; chunk_type: string | null; start_line: number | null; end_line: number | null; rank: number },
        [string, number]
      >(
        `SELECT c.id, c.snippet, c.chunk_index, c.file_id, c.entity_name, c.chunk_type, c.start_line, c.end_line, rank
         FROM fts_chunks f
         JOIN chunks c ON c.id = f.rowid
         WHERE fts_chunks MATCH ?
         ORDER BY rank
         LIMIT ?`
      )
      .all(query, topK);

    return rows.map((row) => {
      const file = this.db
        .query<{ path: string }, [number]>(
          "SELECT path FROM files WHERE id = ?"
        )
        .get(row.file_id)!;

      const score = 1 / (1 + Math.abs(row.rank));

      return {
        path: file.path,
        score,
        content: row.snippet,
        chunkIndex: row.chunk_index,
        entityName: row.entity_name,
        chunkType: row.chunk_type,
        startLine: row.start_line,
        endLine: row.end_line,
      };
    });
  }

  searchSymbols(
    query: string,
    exact: boolean = false,
    type?: string,
    topK: number = 20
  ): SymbolResult[] {
    const pattern = exact ? query : `%${query}%`;

    let sql = `
      SELECT fe.name AS symbol_name, fe.type AS symbol_type, f.path,
        (SELECT snippet FROM chunks
         WHERE file_id = fe.file_id AND LOWER(entity_name) = LOWER(fe.name)
         ORDER BY chunk_index LIMIT 1) AS snippet,
        (SELECT chunk_index FROM chunks
         WHERE file_id = fe.file_id AND LOWER(entity_name) = LOWER(fe.name)
         ORDER BY chunk_index LIMIT 1) AS chunk_index
      FROM file_exports fe
      JOIN files f ON f.id = fe.file_id
      WHERE LOWER(fe.name) LIKE LOWER(?)
    `;
    const params: (string | number)[] = [pattern];

    if (type) {
      sql += " AND fe.type = ?";
      params.push(type);
    }

    sql += " ORDER BY fe.name LIMIT ?";
    params.push(topK);

    return this.db
      .query<{ symbol_name: string; symbol_type: string; path: string; snippet: string | null; chunk_index: number | null }, any[]>(sql)
      .all(...params)
      .map((r) => ({
        path: r.path,
        symbolName: r.symbol_name,
        symbolType: r.symbol_type,
        snippet: r.snippet,
        chunkIndex: r.chunk_index,
      }));
  }

  pruneDeleted(existingPaths: Set<string>): number {
    const allFiles = this.db
      .query<{ id: number; path: string }, []>("SELECT id, path FROM files")
      .all();

    let pruned = 0;
    for (const file of allFiles) {
      if (!existingPaths.has(file.path)) {
        this.removeFile(file.path);
        pruned++;
      }
    }
    return pruned;
  }

  logQuery(query: string, resultCount: number, topScore: number | null, topPath: string | null, durationMs: number) {
    this.db.run(
      "INSERT INTO query_log (query, result_count, top_score, top_path, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [query, resultCount, topScore, topPath, durationMs, new Date().toISOString()]
    );
  }

  getAnalytics(days: number = 30): {
    totalQueries: number;
    avgResultCount: number;
    avgTopScore: number | null;
    zeroResultQueries: { query: string; count: number }[];
    lowScoreQueries: { query: string; topScore: number; timestamp: string }[];
    topSearchedTerms: { query: string; count: number }[];
    queriesPerDay: { date: string; count: number }[];
  } {
    const since = new Date(Date.now() - days * 86400000).toISOString();

    const total = this.db
      .query<{ count: number }, [string]>("SELECT COUNT(*) as count FROM query_log WHERE created_at >= ?")
      .get(since)!;

    const avgResult = this.db
      .query<{ avg: number | null }, [string]>("SELECT AVG(result_count) as avg FROM query_log WHERE created_at >= ?")
      .get(since)!;

    const avgScore = this.db
      .query<{ avg: number | null }, [string]>("SELECT AVG(top_score) as avg FROM query_log WHERE top_score IS NOT NULL AND created_at >= ?")
      .get(since)!;

    const zeroResult = this.db
      .query<{ query: string; count: number }, [string]>(
        "SELECT query, COUNT(*) as count FROM query_log WHERE result_count = 0 AND created_at >= ? GROUP BY query ORDER BY count DESC LIMIT 10"
      )
      .all(since);

    const lowScore = this.db
      .query<{ query: string; top_score: number; created_at: string }, [string]>(
        "SELECT query, top_score, created_at FROM query_log WHERE top_score IS NOT NULL AND top_score < 0.3 AND created_at >= ? ORDER BY top_score ASC LIMIT 10"
      )
      .all(since)
      .map((r) => ({ query: r.query, topScore: r.top_score, timestamp: r.created_at }));

    const topTerms = this.db
      .query<{ query: string; count: number }, [string]>(
        "SELECT query, COUNT(*) as count FROM query_log WHERE created_at >= ? GROUP BY query ORDER BY count DESC LIMIT 10"
      )
      .all(since);

    const perDay = this.db
      .query<{ date: string; count: number }, [string]>(
        "SELECT substr(created_at, 1, 10) as date, COUNT(*) as count FROM query_log WHERE created_at >= ? GROUP BY date ORDER BY date"
      )
      .all(since);

    return {
      totalQueries: total.count,
      avgResultCount: avgResult.avg ?? 0,
      avgTopScore: avgScore.avg,
      zeroResultQueries: zeroResult,
      lowScoreQueries: lowScore,
      topSearchedTerms: topTerms,
      queriesPerDay: perDay,
    };
  }

  upsertFileGraph(
    fileId: number,
    imports: { name: string; source: string }[],
    exports: { name: string; type: string }[]
  ) {
    // Clear old graph data for this file
    this.db.run("DELETE FROM file_imports WHERE file_id = ?", [fileId]);
    this.db.run("DELETE FROM file_exports WHERE file_id = ?", [fileId]);

    for (const imp of imports) {
      this.db.run(
        "INSERT INTO file_imports (file_id, source, names) VALUES (?, ?, ?)",
        [fileId, imp.source, imp.name]
      );
    }

    for (const exp of exports) {
      this.db.run(
        "INSERT INTO file_exports (file_id, name, type) VALUES (?, ?, ?)",
        [fileId, exp.name, exp.type]
      );
    }
  }

  resolveImport(importId: number, resolvedFileId: number) {
    this.db.run(
      "UPDATE file_imports SET resolved_file_id = ? WHERE id = ?",
      [resolvedFileId, importId]
    );
  }

  getUnresolvedImports(): { id: number; fileId: number; filePath: string; source: string }[] {
    return this.db
      .query<{ id: number; file_id: number; path: string; source: string }, []>(
        `SELECT fi.id, fi.file_id, f.path, fi.source
         FROM file_imports fi
         JOIN files f ON f.id = fi.file_id
         WHERE fi.resolved_file_id IS NULL`
      )
      .all()
      .map((r) => ({ id: r.id, fileId: r.file_id, filePath: r.path, source: r.source }));
  }

  getAllFilePaths(): { id: number; path: string }[] {
    return this.db
      .query<{ id: number; path: string }, []>("SELECT id, path FROM files")
      .all();
  }

  getGraph(): {
    nodes: { id: number; path: string; exports: { name: string; type: string }[] }[];
    edges: { fromId: number; fromPath: string; toId: number; toPath: string; source: string }[];
  } {
    const files = this.db
      .query<{ id: number; path: string }, []>("SELECT id, path FROM files")
      .all();

    const nodes = files.map((f) => {
      const exports = this.db
        .query<{ name: string; type: string }, [number]>(
          "SELECT name, type FROM file_exports WHERE file_id = ?"
        )
        .all(f.id);
      return { id: f.id, path: f.path, exports };
    });

    const edges = this.db
      .query<
        { file_id: number; from_path: string; resolved_file_id: number; to_path: string; source: string },
        []
      >(
        `SELECT fi.file_id, f1.path as from_path, fi.resolved_file_id, f2.path as to_path, fi.source
         FROM file_imports fi
         JOIN files f1 ON f1.id = fi.file_id
         JOIN files f2 ON f2.id = fi.resolved_file_id
         WHERE fi.resolved_file_id IS NOT NULL`
      )
      .all()
      .map((r) => ({
        fromId: r.file_id,
        fromPath: r.from_path,
        toId: r.resolved_file_id,
        toPath: r.to_path,
        source: r.source,
      }));

    return { nodes, edges };
  }

  getSubgraph(fileIds: number[], maxHops: number = 2): {
    nodes: { id: number; path: string; exports: { name: string; type: string }[] }[];
    edges: { fromId: number; fromPath: string; toId: number; toPath: string; source: string }[];
  } {
    const fullGraph = this.getGraph();
    const visited = new Set<number>(fileIds);
    let frontier = new Set<number>(fileIds);

    for (let hop = 0; hop < maxHops; hop++) {
      const nextFrontier = new Set<number>();
      for (const edge of fullGraph.edges) {
        if (frontier.has(edge.fromId) && !visited.has(edge.toId)) {
          nextFrontier.add(edge.toId);
          visited.add(edge.toId);
        }
        if (frontier.has(edge.toId) && !visited.has(edge.fromId)) {
          nextFrontier.add(edge.fromId);
          visited.add(edge.fromId);
        }
      }
      frontier = nextFrontier;
      if (frontier.size === 0) break;
    }

    const nodes = fullGraph.nodes.filter((n) => visited.has(n.id));
    const edges = fullGraph.edges.filter((e) => visited.has(e.fromId) && visited.has(e.toId));

    return { nodes, edges };
  }

  getImportsForFile(fileId: number): { id: number; source: string; resolvedFileId: number | null }[] {
    return this.db
      .query<{ id: number; source: string; resolved_file_id: number | null }, [number]>(
        "SELECT id, source, resolved_file_id FROM file_imports WHERE file_id = ?"
      )
      .all(fileId)
      .map((r) => ({ id: r.id, source: r.source, resolvedFileId: r.resolved_file_id }));
  }

  getImportersOf(fileId: number): number[] {
    return this.db
      .query<{ file_id: number }, [number]>(
        "SELECT file_id FROM file_imports WHERE resolved_file_id = ?"
      )
      .all(fileId)
      .map((r) => r.file_id);
  }

  getAnalyticsTrend(days: number = 7): {
    current: { totalQueries: number; avgTopScore: number | null; zeroResultRate: number };
    previous: { totalQueries: number; avgTopScore: number | null; zeroResultRate: number };
    delta: { queries: number; avgTopScore: number | null; zeroResultRate: number };
  } {
    const now = Date.now();
    const currentStart = new Date(now - days * 86400000).toISOString();
    const previousStart = new Date(now - days * 2 * 86400000).toISOString();

    const getCounts = (since: string, until: string) => {
      const total = this.db
        .query<{ count: number }, [string, string]>(
          "SELECT COUNT(*) as count FROM query_log WHERE created_at >= ? AND created_at < ?"
        )
        .get(since, until)!;

      const avgScore = this.db
        .query<{ avg: number | null }, [string, string]>(
          "SELECT AVG(top_score) as avg FROM query_log WHERE top_score IS NOT NULL AND created_at >= ? AND created_at < ?"
        )
        .get(since, until)!;

      const zeroCount = this.db
        .query<{ count: number }, [string, string]>(
          "SELECT COUNT(*) as count FROM query_log WHERE result_count = 0 AND created_at >= ? AND created_at < ?"
        )
        .get(since, until)!;

      const zeroResultRate = total.count > 0 ? zeroCount.count / total.count : 0;

      return { totalQueries: total.count, avgTopScore: avgScore.avg, zeroResultRate };
    };

    // Use a far-future upper bound for current period to include all recent entries
    const farFuture = "9999-12-31T23:59:59.999Z";
    const current = getCounts(currentStart, farFuture);
    const previous = getCounts(previousStart, currentStart);

    const delta = {
      queries: current.totalQueries - previous.totalQueries,
      avgTopScore:
        current.avgTopScore !== null && previous.avgTopScore !== null
          ? current.avgTopScore - previous.avgTopScore
          : null,
      zeroResultRate: current.zeroResultRate - previous.zeroResultRate,
    };

    return { current, previous, delta };
  }

  getStatus(): { totalFiles: number; totalChunks: number; lastIndexed: string | null } {
    const files = this.db
      .query<{ count: number }, []>("SELECT COUNT(*) as count FROM files")
      .get()!;
    const chunks = this.db
      .query<{ count: number }, []>("SELECT COUNT(*) as count FROM chunks")
      .get()!;
    const last = this.db
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

  // ── Conversation methods ────────────────────────────────────────

  upsertSession(
    sessionId: string,
    jsonlPath: string,
    startedAt: string,
    mtime: number,
    readOffset: number
  ) {
    this.db.run(
      `INSERT INTO conversation_sessions (session_id, jsonl_path, started_at, indexed_at, file_mtime, read_offset)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         file_mtime = excluded.file_mtime,
         indexed_at = excluded.indexed_at,
         read_offset = excluded.read_offset`,
      [sessionId, jsonlPath, startedAt, new Date().toISOString(), mtime, readOffset]
    );
  }

  getSession(sessionId: string): {
    id: number;
    sessionId: string;
    jsonlPath: string;
    mtime: number;
    readOffset: number;
    turnCount: number;
  } | null {
    const row = this.db
      .query<
        { id: number; session_id: string; jsonl_path: string; file_mtime: number; read_offset: number; turn_count: number },
        [string]
      >("SELECT id, session_id, jsonl_path, file_mtime, read_offset, turn_count FROM conversation_sessions WHERE session_id = ?")
      .get(sessionId);
    if (!row) return null;
    return {
      id: row.id,
      sessionId: row.session_id,
      jsonlPath: row.jsonl_path,
      mtime: row.file_mtime,
      readOffset: row.read_offset,
      turnCount: row.turn_count,
    };
  }

  updateSessionStats(sessionId: string, turnCount: number, totalTokens: number, readOffset: number) {
    this.db.run(
      `UPDATE conversation_sessions SET turn_count = ?, total_tokens = ?, read_offset = ?, indexed_at = ? WHERE session_id = ?`,
      [turnCount, totalTokens, readOffset, new Date().toISOString(), sessionId]
    );
  }

  insertTurn(
    sessionId: string,
    turnIndex: number,
    timestamp: string,
    userText: string,
    assistantText: string,
    toolsUsed: string[],
    filesReferenced: string[],
    tokenCost: number,
    summary: string,
    chunks: { snippet: string; embedding: Float32Array }[]
  ): number {
    let turnId = 0;

    const tx = this.db.transaction(() => {
      this.db.run(
        `INSERT OR IGNORE INTO conversation_turns
         (session_id, turn_index, timestamp, user_text, assistant_text, tools_used, files_referenced, token_cost, summary)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          sessionId,
          turnIndex,
          timestamp,
          userText,
          assistantText,
          JSON.stringify(toolsUsed),
          JSON.stringify(filesReferenced),
          tokenCost,
          summary,
        ]
      );

      turnId = Number(
        this.db.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!.id
      );

      // Skip if this was a duplicate (OR IGNORE)
      if (turnId === 0) return;

      for (let i = 0; i < chunks.length; i++) {
        const { snippet, embedding } = chunks[i];
        this.db.run(
          "INSERT INTO conversation_chunks (turn_id, chunk_index, snippet) VALUES (?, ?, ?)",
          [turnId, i, snippet]
        );
        const chunkId = Number(
          this.db.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!.id
        );
        this.db.run(
          "INSERT INTO vec_conversation (chunk_id, embedding) VALUES (?, ?)",
          [chunkId, new Uint8Array(embedding.buffer)]
        );
      }
    });

    tx();
    return turnId;
  }

  getTurnCount(sessionId: string): number {
    const row = this.db
      .query<{ count: number }, [string]>(
        "SELECT COUNT(*) as count FROM conversation_turns WHERE session_id = ?"
      )
      .get(sessionId)!;
    return row.count;
  }

  searchConversation(
    queryEmbedding: Float32Array,
    topK: number = 5,
    sessionId?: string
  ): ConversationSearchResult[] {
    // Vector search
    const vecRows = this.db
      .query<{ chunk_id: number; distance: number }, [Uint8Array, number]>(
        `SELECT chunk_id, distance
         FROM vec_conversation
         WHERE embedding MATCH ?
         ORDER BY distance
         LIMIT ?`
      )
      .all(new Uint8Array(queryEmbedding.buffer), topK * 3);

    const results: ConversationSearchResult[] = [];
    const seenTurns = new Set<number>();

    for (const row of vecRows) {
      const chunk = this.db
        .query<{ turn_id: number; snippet: string }, [number]>(
          "SELECT turn_id, snippet FROM conversation_chunks WHERE id = ?"
        )
        .get(row.chunk_id);
      if (!chunk) continue;

      if (seenTurns.has(chunk.turn_id)) continue;
      seenTurns.add(chunk.turn_id);

      const turn = this.db
        .query<
          {
            id: number;
            turn_index: number;
            session_id: string;
            timestamp: string;
            summary: string;
            tools_used: string;
            files_referenced: string;
          },
          [number]
        >(
          "SELECT id, turn_index, session_id, timestamp, summary, tools_used, files_referenced FROM conversation_turns WHERE id = ?"
        )
        .get(chunk.turn_id);
      if (!turn) continue;

      // Filter by session if specified
      if (sessionId && turn.session_id !== sessionId) continue;

      const score = 1 / (1 + row.distance);
      results.push({
        turnId: turn.id,
        turnIndex: turn.turn_index,
        sessionId: turn.session_id,
        timestamp: turn.timestamp,
        summary: turn.summary || "",
        snippet: chunk.snippet,
        toolsUsed: JSON.parse(turn.tools_used || "[]"),
        filesReferenced: JSON.parse(turn.files_referenced || "[]"),
        score,
      });

      if (results.length >= topK) break;
    }

    return results;
  }

  textSearchConversation(
    query: string,
    topK: number = 5,
    sessionId?: string
  ): ConversationSearchResult[] {
    const rows = this.db
      .query<
        { id: number; snippet: string; turn_id: number; rank: number },
        [string, number]
      >(
        `SELECT cc.id, cc.snippet, cc.turn_id, rank
         FROM fts_conversation f
         JOIN conversation_chunks cc ON cc.id = f.rowid
         WHERE fts_conversation MATCH ?
         ORDER BY rank
         LIMIT ?`
      )
      .all(query, topK * 3);

    const results: ConversationSearchResult[] = [];
    const seenTurns = new Set<number>();

    for (const row of rows) {
      if (seenTurns.has(row.turn_id)) continue;
      seenTurns.add(row.turn_id);

      const turn = this.db
        .query<
          {
            id: number;
            turn_index: number;
            session_id: string;
            timestamp: string;
            summary: string;
            tools_used: string;
            files_referenced: string;
          },
          [number]
        >(
          "SELECT id, turn_index, session_id, timestamp, summary, tools_used, files_referenced FROM conversation_turns WHERE id = ?"
        )
        .get(row.turn_id);
      if (!turn) continue;

      if (sessionId && turn.session_id !== sessionId) continue;

      const score = 1 / (1 + Math.abs(row.rank));
      results.push({
        turnId: turn.id,
        turnIndex: turn.turn_index,
        sessionId: turn.session_id,
        timestamp: turn.timestamp,
        summary: turn.summary || "",
        snippet: row.snippet,
        toolsUsed: JSON.parse(turn.tools_used || "[]"),
        filesReferenced: JSON.parse(turn.files_referenced || "[]"),
        score,
      });

      if (results.length >= topK) break;
    }

    return results;
  }

  // ── Checkpoint methods ─────────────────────────────────────────

  createCheckpoint(
    sessionId: string,
    turnIndex: number,
    timestamp: string,
    type: string,
    title: string,
    summary: string,
    filesInvolved: string[],
    tags: string[],
    embedding: Float32Array
  ): number {
    let checkpointId = 0;

    const tx = this.db.transaction(() => {
      this.db.run(
        `INSERT INTO conversation_checkpoints
         (session_id, turn_index, timestamp, type, title, summary, files_involved, tags, embedding)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          sessionId,
          turnIndex,
          timestamp,
          type,
          title,
          summary,
          JSON.stringify(filesInvolved),
          JSON.stringify(tags),
          new Uint8Array(embedding.buffer),
        ]
      );

      checkpointId = Number(
        this.db.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!.id
      );

      this.db.run(
        "INSERT INTO vec_checkpoints (checkpoint_id, embedding) VALUES (?, ?)",
        [checkpointId, new Uint8Array(embedding.buffer)]
      );
    });

    tx();
    return checkpointId;
  }

  listCheckpoints(
    sessionId?: string,
    type?: string,
    limit: number = 20
  ): CheckpointRow[] {
    let sql = "SELECT * FROM conversation_checkpoints WHERE 1=1";
    const params: (string | number)[] = [];

    if (sessionId) {
      sql += " AND session_id = ?";
      params.push(sessionId);
    }
    if (type) {
      sql += " AND type = ?";
      params.push(type);
    }

    sql += " ORDER BY timestamp DESC LIMIT ?";
    params.push(limit);

    return this.db
      .query<any, any[]>(sql)
      .all(...params)
      .map((r: any) => ({
        id: r.id,
        sessionId: r.session_id,
        turnIndex: r.turn_index,
        timestamp: r.timestamp,
        type: r.type,
        title: r.title,
        summary: r.summary,
        filesInvolved: JSON.parse(r.files_involved || "[]"),
        tags: JSON.parse(r.tags || "[]"),
      }));
  }

  searchCheckpoints(
    queryEmbedding: Float32Array,
    topK: number = 5,
    type?: string
  ): (CheckpointRow & { score: number })[] {
    const vecRows = this.db
      .query<{ checkpoint_id: number; distance: number }, [Uint8Array, number]>(
        `SELECT checkpoint_id, distance
         FROM vec_checkpoints
         WHERE embedding MATCH ?
         ORDER BY distance
         LIMIT ?`
      )
      .all(new Uint8Array(queryEmbedding.buffer), topK * 2);

    const results: (CheckpointRow & { score: number })[] = [];

    for (const row of vecRows) {
      const cp = this.db
        .query<any, [number]>(
          "SELECT * FROM conversation_checkpoints WHERE id = ?"
        )
        .get(row.checkpoint_id);
      if (!cp) continue;
      if (type && cp.type !== type) continue;

      results.push({
        id: cp.id,
        sessionId: cp.session_id,
        turnIndex: cp.turn_index,
        timestamp: cp.timestamp,
        type: cp.type,
        title: cp.title,
        summary: cp.summary,
        filesInvolved: JSON.parse(cp.files_involved || "[]"),
        tags: JSON.parse(cp.tags || "[]"),
        score: 1 / (1 + row.distance),
      });

      if (results.length >= topK) break;
    }

    return results;
  }

  getCheckpoint(id: number): CheckpointRow | null {
    const r = this.db
      .query<any, [number]>(
        "SELECT * FROM conversation_checkpoints WHERE id = ?"
      )
      .get(id);
    if (!r) return null;
    return {
      id: r.id,
      sessionId: r.session_id,
      turnIndex: r.turn_index,
      timestamp: r.timestamp,
      type: r.type,
      title: r.title,
      summary: r.summary,
      filesInvolved: JSON.parse(r.files_involved || "[]"),
      tags: JSON.parse(r.tags || "[]"),
    };
  }

  /**
   * Find usages of a symbol across the codebase.
   * Uses FTS to locate chunks containing the symbol, then excludes the files
   * that define it (via file_exports). Returns up to `top` results with
   * per-match line numbers derived from the chunk's start_line.
   */
  findUsages(symbolName: string, exact: boolean, top: number): UsageResult[] {
    // Files that export (define) this symbol — excluded from results
    const definingFileIds = new Set(
      this.db
        .query<{ file_id: number }, [string]>(
          "SELECT file_id FROM file_exports WHERE LOWER(name) = LOWER(?)"
        )
        .all(symbolName)
        .map((r) => r.file_id)
    );

    // FTS search for chunks containing the symbol name
    let rows: { id: number; snippet: string; file_id: number; chunk_index: number; start_line: number | null }[] = [];
    try {
      const ftsQuery = `"${symbolName.replace(/"/g, '""')}"`;
      rows = this.db
        .query<
          { id: number; snippet: string; file_id: number; chunk_index: number; start_line: number | null },
          [string, number]
        >(
          `SELECT c.id, c.snippet, c.file_id, c.chunk_index, c.start_line
           FROM fts_chunks f
           JOIN chunks c ON c.id = f.rowid
           WHERE fts_chunks MATCH ?
           ORDER BY rank
           LIMIT ?`
        )
        .all(ftsQuery, top * 5);
    } catch {
      // FTS may fail on special chars — return empty
      return [];
    }

    const pattern = exact
      ? new RegExp(`\\b${escapeRegex(symbolName)}\\b`, "i")
      : new RegExp(`\\b${escapeRegex(symbolName)}`, "i");

    const results: UsageResult[] = [];

    for (const row of rows) {
      if (definingFileIds.has(row.file_id)) continue;

      const file = this.db
        .query<{ path: string }, [number]>("SELECT path FROM files WHERE id = ?")
        .get(row.file_id);
      if (!file) continue;

      // Find which line within the chunk matches
      const lines = row.snippet.split("\n");
      let matchOffset = -1;
      let matchSnippet = row.snippet.slice(0, 120).trim();

      for (let i = 0; i < lines.length; i++) {
        if (pattern.test(lines[i])) {
          matchOffset = i;
          matchSnippet = lines[i].trim();
          break;
        }
      }

      // Combine chunk start_line with within-chunk offset for absolute line number
      const line =
        row.start_line != null && matchOffset >= 0
          ? row.start_line + matchOffset - 1
          : row.start_line;

      results.push({ path: file.path, line, snippet: matchSnippet });
      if (results.length >= top) break;
    }

    return results;
  }

  // ── Annotation methods ──────────────────────────────────────────

  /**
   * Upsert an annotation for a file or symbol.
   * Key: (path, symbol_name). Calling again on the same target updates the note.
   * FTS is managed manually (no triggers) so UPDATE is handled cleanly.
   */
  upsertAnnotation(
    path: string,
    note: string,
    embedding: Float32Array,
    symbolName?: string | null,
    author?: string | null
  ): number {
    let annotationId = 0;

    const tx = this.db.transaction(() => {
      // Find existing annotation for this path+symbol key
      let existing: { id: number; note: string } | null = null;
      if (symbolName) {
        existing = this.db
          .query<{ id: number; note: string }, [string, string]>(
            "SELECT id, note FROM annotations WHERE path = ? AND symbol_name = ?"
          )
          .get(path, symbolName);
      } else {
        existing = this.db
          .query<{ id: number; note: string }, [string]>(
            "SELECT id, note FROM annotations WHERE path = ? AND symbol_name IS NULL"
          )
          .get(path);
      }

      const now = new Date().toISOString();

      if (existing) {
        // Remove old FTS entry
        this.db.run(
          "INSERT INTO fts_annotations(fts_annotations, rowid, note) VALUES ('delete', ?, ?)",
          [existing.id, existing.note]
        );
        // Update the row
        this.db.run(
          "UPDATE annotations SET note = ?, author = ?, updated_at = ? WHERE id = ?",
          [note, author ?? null, now, existing.id]
        );
        // Re-insert into FTS
        this.db.run("INSERT INTO fts_annotations(rowid, note) VALUES (?, ?)", [existing.id, note]);
        // Replace vector
        this.db.run("DELETE FROM vec_annotations WHERE annotation_id = ?", [existing.id]);
        this.db.run(
          "INSERT INTO vec_annotations (annotation_id, embedding) VALUES (?, ?)",
          [existing.id, new Uint8Array(embedding.buffer)]
        );
        annotationId = existing.id;
      } else {
        // Insert new annotation
        this.db.run(
          "INSERT INTO annotations (path, symbol_name, note, author, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
          [path, symbolName ?? null, note, author ?? null, now, now]
        );
        annotationId = Number(
          this.db.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!.id
        );
        // Insert into FTS
        this.db.run("INSERT INTO fts_annotations(rowid, note) VALUES (?, ?)", [annotationId, note]);
        // Insert vector
        this.db.run(
          "INSERT INTO vec_annotations (annotation_id, embedding) VALUES (?, ?)",
          [annotationId, new Uint8Array(embedding.buffer)]
        );
      }
    });

    tx();
    return annotationId;
  }

  getAnnotations(path?: string, symbolName?: string | null): AnnotationRow[] {
    let sql = "SELECT * FROM annotations WHERE 1=1";
    const params: (string | null)[] = [];

    if (path !== undefined) {
      sql += " AND path = ?";
      params.push(path);
    }
    if (symbolName !== undefined) {
      if (symbolName === null) {
        sql += " AND symbol_name IS NULL";
      } else {
        sql += " AND symbol_name = ?";
        params.push(symbolName);
      }
    }

    sql += " ORDER BY updated_at DESC";

    return this.db
      .query<any, any[]>(sql)
      .all(...params)
      .map((r: any) => ({
        id: r.id,
        path: r.path,
        symbolName: r.symbol_name,
        note: r.note,
        author: r.author,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }));
  }

  searchAnnotations(
    queryEmbedding: Float32Array,
    topK: number = 10
  ): (AnnotationRow & { score: number })[] {
    const rows = this.db
      .query<{ annotation_id: number; distance: number }, [Uint8Array, number]>(
        `SELECT annotation_id, distance
         FROM vec_annotations
         WHERE embedding MATCH ?
         ORDER BY distance
         LIMIT ?`
      )
      .all(new Uint8Array(queryEmbedding.buffer), topK);

    const results: (AnnotationRow & { score: number })[] = [];
    for (const row of rows) {
      const ann = this.db
        .query<any, [number]>("SELECT * FROM annotations WHERE id = ?")
        .get(row.annotation_id);
      if (!ann) continue;
      results.push({
        id: ann.id,
        path: ann.path,
        symbolName: ann.symbol_name,
        note: ann.note,
        author: ann.author,
        createdAt: ann.created_at,
        updatedAt: ann.updated_at,
        score: 1 / (1 + row.distance),
      });
    }
    return results;
  }

  deleteAnnotation(id: number): boolean {
    const existing = this.db
      .query<{ id: number; note: string }, [number]>(
        "SELECT id, note FROM annotations WHERE id = ?"
      )
      .get(id);
    if (!existing) return false;

    const tx = this.db.transaction(() => {
      this.db.run(
        "INSERT INTO fts_annotations(fts_annotations, rowid, note) VALUES ('delete', ?, ?)",
        [id, existing.note]
      );
      this.db.run("DELETE FROM vec_annotations WHERE annotation_id = ?", [id]);
      this.db.run("DELETE FROM annotations WHERE id = ?", [id]);
    });

    tx();
    return true;
  }

  close() {
    this.db.close();
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
