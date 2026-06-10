import { embeddingBytes } from "../utils/vec";
import { Database } from "bun:sqlite";
import { type ConversationSearchResult } from "./types";
import { sanitizeFTS } from "../search/usages";

export function upsertSession(
  db: Database,
  sessionId: string,
  jsonlPath: string,
  startedAt: string,
  mtime: number,
  readOffset: number
) {
  db.run(
    `INSERT INTO conversation_sessions (session_id, jsonl_path, started_at, indexed_at, file_mtime, read_offset)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       file_mtime = excluded.file_mtime,
       indexed_at = excluded.indexed_at,
       read_offset = excluded.read_offset`,
    [sessionId, jsonlPath, startedAt, new Date().toISOString(), mtime, readOffset]
  );
}

export function getSession(db: Database, sessionId: string): {
  id: number;
  sessionId: string;
  jsonlPath: string;
  mtime: number;
  readOffset: number;
  turnCount: number;
} | null {
  const row = db
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

export function updateSessionStats(db: Database, sessionId: string, turnCount: number, totalTokens: number, readOffset: number) {
  db.run(
    `UPDATE conversation_sessions SET turn_count = ?, total_tokens = ?, read_offset = ?, indexed_at = ? WHERE session_id = ?`,
    [turnCount, totalTokens, readOffset, new Date().toISOString(), sessionId]
  );
}

/**
 * Insert or REPLACE a turn at (session_id, turn_index).
 *
 * Replace (not ignore) is load-bearing for incremental indexing: the cursor is
 * held back to the last turn's start, so that turn is re-parsed on the next
 * pass with whatever continuation arrived since. INSERT OR IGNORE silently
 * dropped the completed version — measured at 46% of turns missing assistant
 * text in this repo's own index.
 */
export function upsertTurn(
  db: Database,
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

  const tx = db.transaction(() => {
    // Drop any existing version of this turn. Chunks are deleted explicitly
    // (FK cascade isn't guaranteed on); the conv_chunks_ad / conv_chunks_vec_ad
    // triggers clear the FTS and vec rows.
    const existing = db
      .query<{ id: number }, [string, number]>(
        "SELECT id FROM conversation_turns WHERE session_id = ? AND turn_index = ?"
      )
      .get(sessionId, turnIndex);
    if (existing) {
      db.run("DELETE FROM conversation_chunks WHERE turn_id = ?", [existing.id]);
      db.run("DELETE FROM conversation_turns WHERE id = ?", [existing.id]);
    }

    db.run(
      `INSERT INTO conversation_turns
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
      db.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!.id
    );

    for (let i = 0; i < chunks.length; i++) {
      const { snippet, embedding } = chunks[i];
      db.run(
        "INSERT INTO conversation_chunks (turn_id, chunk_index, snippet) VALUES (?, ?, ?)",
        [turnId, i, snippet]
      );
      const chunkId = Number(
        db.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!.id
      );
      db.run(
        "INSERT INTO vec_conversation (chunk_id, embedding) VALUES (?, ?)",
        [chunkId, embeddingBytes(embedding)]
      );
    }
  });

  tx();
  return turnId;
}

/** Stored texts + timestamp of one turn, for rewind detection. */
export function getTurnByIndex(
  db: Database,
  sessionId: string,
  turnIndex: number
): { userText: string; assistantText: string; timestamp: string } | null {
  const row = db
    .query<{ user_text: string; assistant_text: string; timestamp: string }, [string, number]>(
      "SELECT user_text, assistant_text, timestamp FROM conversation_turns WHERE session_id = ? AND turn_index = ?"
    )
    .get(sessionId, turnIndex);
  return row
    ? { userText: row.user_text || "", assistantText: row.assistant_text || "", timestamp: row.timestamp || "" }
    : null;
}

/**
 * The stored chunk snippets of a turn, joined in order with NUL. Chunking is
 * deterministic, so comparing this against a fresh parse's chunks detects ANY
 * content change — including tool-result-only continuations, which a
 * user/assistant text comparison misses.
 */
export function getTurnChunkText(db: Database, sessionId: string, turnIndex: number): string | null {
  // ORDER BY must live INSIDE the aggregate: a trailing ORDER BY orders the
  // single output row, not the concatenation — today's correct order is an
  // accident of insertion-order table scans and would silently flip under a
  // future index on turn_id (verified empirically on SQLite 3.51).
  const row = db
    .query<{ joined: string | null }, [string, number]>(
      `SELECT GROUP_CONCAT(cc.snippet, char(0) ORDER BY cc.chunk_index) as joined
       FROM conversation_chunks cc
       JOIN conversation_turns ct ON ct.id = cc.turn_id
       WHERE ct.session_id = ? AND ct.turn_index = ?`
    )
    .get(sessionId, turnIndex);
  return row?.joined ?? null;
}

/**
 * Delete stored turns with turn_index above `maxKeep`. Used after a full
 * from-offset-0 re-parse to reconcile a gapped/drifted legacy index: the
 * re-parse upserts turns 0..m, and any stale stored rows above m would
 * otherwise survive and collide with future cursor resumes.
 */
export function deleteTurnsAbove(db: Database, sessionId: string, maxKeep: number): void {
  const tx = db.transaction(() => {
    db.run(
      `DELETE FROM conversation_chunks WHERE turn_id IN
       (SELECT id FROM conversation_turns WHERE session_id = ? AND turn_index > ?)`,
      [sessionId, maxKeep]
    );
    db.run("DELETE FROM conversation_turns WHERE session_id = ? AND turn_index > ?", [sessionId, maxKeep]);
  });
  tx();
}

/** Total token cost across all stored turns — the source of truth for
 *  session stats (a per-pass sum would clobber the total on every tick). */
export function sumSessionTokens(db: Database, sessionId: string): number {
  const row = db
    .query<{ total: number | null }, [string]>(
      "SELECT SUM(token_cost) as total FROM conversation_turns WHERE session_id = ?"
    )
    .get(sessionId);
  return row?.total ?? 0;
}

/**
 * Delete every stored turn (and chunks/FTS/vec via triggers) for a session and
 * reset its cursor. Used by `conversation index --rebuild` to recover indexes
 * written before the cursor fix (turn tails lost, indices drifted).
 */
export function deleteSessionTurns(db: Database, sessionId: string): void {
  const tx = db.transaction(() => {
    db.run(
      `DELETE FROM conversation_chunks WHERE turn_id IN
       (SELECT id FROM conversation_turns WHERE session_id = ?)`,
      [sessionId]
    );
    db.run("DELETE FROM conversation_turns WHERE session_id = ?", [sessionId]);
    db.run(
      "UPDATE conversation_sessions SET turn_count = 0, total_tokens = 0, read_offset = 0 WHERE session_id = ?",
      [sessionId]
    );
  });
  tx();
}

/**
 * Highest stored turn_index for a session, or null when none. This — not
 * COUNT(*) — is the resume point and clamp bound: stored indices can have
 * gaps, and COUNT-based math made the newest turns unreadable and collided
 * new batches onto existing indices.
 */
export function getMaxTurnIndex(db: Database, sessionId: string): number | null {
  const row = db
    .query<{ max_idx: number | null }, [string]>(
      "SELECT MAX(turn_index) as max_idx FROM conversation_turns WHERE session_id = ?"
    )
    .get(sessionId);
  return row?.max_idx ?? null;
}

export interface ConversationTurnRow {
  turnIndex: number;
  timestamp: string;
  userText: string;
  assistantText: string;
  toolsUsed: string[];
  filesReferenced: string[];
  tokenCost: number;
}

/**
 * Fetch the full stored turns for a session within an inclusive turn-index
 * range, ordered oldest-first. Returns the complete `user_text`/`assistant_text`
 * — not the search snippet. Tool-result bodies are not stored here (selective
 * indexing drops most), so callers needing those re-parse the transcript.
 */
export function getTurnRange(
  db: Database,
  sessionId: string,
  fromIdx: number,
  toIdx: number
): ConversationTurnRow[] {
  const rows = db
    .query<
      {
        turn_index: number;
        timestamp: string;
        user_text: string;
        assistant_text: string;
        tools_used: string;
        files_referenced: string;
        token_cost: number;
      },
      [string, number, number]
    >(
      `SELECT turn_index, timestamp, user_text, assistant_text, tools_used, files_referenced, token_cost
       FROM conversation_turns
       WHERE session_id = ? AND turn_index BETWEEN ? AND ?
       ORDER BY turn_index`
    )
    .all(sessionId, fromIdx, toIdx);

  return rows.map((r) => ({
    turnIndex: r.turn_index,
    timestamp: r.timestamp,
    userText: r.user_text || "",
    assistantText: r.assistant_text || "",
    toolsUsed: JSON.parse(r.tools_used || "[]"),
    filesReferenced: JSON.parse(r.files_referenced || "[]"),
    tokenCost: r.token_cost,
  }));
}

export function getTurnCount(db: Database, sessionId: string): number {
  const row = db
    .query<{ count: number }, [string]>(
      "SELECT COUNT(*) as count FROM conversation_turns WHERE session_id = ?"
    )
    .get(sessionId)!;
  return row.count;
}

export function searchConversation(
  db: Database,
  queryEmbedding: Float32Array,
  topK: number = 5,
  sessionId?: string
): ConversationSearchResult[] {
  // Use subquery for vector search, then JOIN for turn data
  const rows = db
    .query<
      {
        chunk_id: number;
        distance: number;
        snippet: string;
        turn_id: number;
        turn_index: number;
        session_id: string;
        timestamp: string;
        summary: string;
        tools_used: string;
        files_referenced: string;
      },
      [Uint8Array, number]
    >(
      `SELECT v.chunk_id, v.distance, cc.snippet, cc.turn_id,
              ct.turn_index, ct.session_id, ct.timestamp, ct.summary, ct.tools_used, ct.files_referenced
       FROM (SELECT chunk_id, distance FROM vec_conversation WHERE embedding MATCH ? ORDER BY distance LIMIT ?) v
       JOIN conversation_chunks cc ON cc.id = v.chunk_id
       JOIN conversation_turns ct ON ct.id = cc.turn_id`
    )
    .all(embeddingBytes(queryEmbedding), sessionId ? topK * 10 : topK * 3);

  const results: ConversationSearchResult[] = [];
  const seenTurns = new Set<number>();

  for (const row of rows) {
    if (seenTurns.has(row.turn_id)) continue;
    seenTurns.add(row.turn_id);

    if (sessionId && row.session_id !== sessionId) continue;

    results.push({
      turnId: row.turn_id,
      turnIndex: row.turn_index,
      sessionId: row.session_id,
      timestamp: row.timestamp,
      summary: row.summary || "",
      snippet: row.snippet,
      toolsUsed: JSON.parse(row.tools_used || "[]"),
      filesReferenced: JSON.parse(row.files_referenced || "[]"),
      score: 1 / (1 + row.distance),
    });

    if (results.length >= topK) break;
  }

  return results;
}

export function textSearchConversation(
  db: Database,
  query: string,
  topK: number = 5,
  sessionId?: string
): ConversationSearchResult[] {
  const rows = db
    .query<
      {
        snippet: string;
        turn_id: number;
        rank: number;
        turn_index: number;
        session_id: string;
        timestamp: string;
        summary: string;
        tools_used: string;
        files_referenced: string;
      },
      [string, number]
    >(
      `SELECT cc.snippet, cc.turn_id, rank,
              ct.turn_index, ct.session_id, ct.timestamp, ct.summary, ct.tools_used, ct.files_referenced
       FROM fts_conversation fts
       JOIN conversation_chunks cc ON cc.id = fts.rowid
       JOIN conversation_turns ct ON ct.id = cc.turn_id
       WHERE fts_conversation MATCH ?
       ORDER BY rank
       LIMIT ?`
    )
    .all(sanitizeFTS(query), sessionId ? topK * 10 : topK * 3);

  const results: ConversationSearchResult[] = [];
  const seenTurns = new Set<number>();

  for (const row of rows) {
    if (seenTurns.has(row.turn_id)) continue;
    seenTurns.add(row.turn_id);

    if (sessionId && row.session_id !== sessionId) continue;

    results.push({
      turnId: row.turn_id,
      turnIndex: row.turn_index,
      sessionId: row.session_id,
      timestamp: row.timestamp,
      summary: row.summary || "",
      snippet: row.snippet,
      toolsUsed: JSON.parse(row.tools_used || "[]"),
      filesReferenced: JSON.parse(row.files_referenced || "[]"),
      score: 1 / (1 + Math.abs(row.rank)),
    });

    if (results.length >= topK) break;
  }

  return results;
}
