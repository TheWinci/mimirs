import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { EMBEDDING_DIM } from "./embed";
import { join } from "path";
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
}

export class RagDB {
  private db: Database;

  constructor(projectDir: string) {
    const ragDir = join(projectDir, ".rag");
    mkdirSync(ragDir, { recursive: true });

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
        snippet TEXT NOT NULL
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
  }

  getFileByPath(path: string): StoredFile | null {
    return this.db
      .query<StoredFile, [string]>("SELECT * FROM files WHERE path = ?")
      .get(path);
  }

  upsertFile(
    path: string,
    hash: string,
    chunks: { snippet: string; embedding: Float32Array }[]
  ) {
    const tx = this.db.transaction(() => {
      // Remove old data if exists
      const existing = this.getFileByPath(path);
      if (existing) {
        // Get chunk IDs to remove from vec table
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
      }

      // Insert file record
      this.db.run(
        "INSERT INTO files (path, hash, indexed_at) VALUES (?, ?, ?)",
        [path, hash, new Date().toISOString()]
      );
      const fileId = Number(
        this.db.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!.id
      );

      // Insert chunks + vectors
      for (let i = 0; i < chunks.length; i++) {
        const { snippet, embedding } = chunks[i];
        this.db.run(
          "INSERT INTO chunks (file_id, chunk_index, snippet) VALUES (?, ?, ?)",
          [fileId, i, snippet]
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
          { snippet: string; chunk_index: number; file_id: number },
          [number]
        >("SELECT snippet, chunk_index, file_id FROM chunks WHERE id = ?")
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
      };
    });
  }

  textSearch(query: string, topK: number = 5): SearchResult[] {
    // FTS5 bm25() returns negative scores (lower = better match)
    const rows = this.db
      .query<
        { id: number; snippet: string; chunk_index: number; file_id: number; rank: number },
        [string, number]
      >(
        `SELECT c.id, c.snippet, c.chunk_index, c.file_id, rank
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
      };
    });
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

  close() {
    this.db.close();
  }
}
