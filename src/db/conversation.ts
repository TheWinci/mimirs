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

export function insertTurn(
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
    db.run(
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

    // If the INSERT was ignored (duplicate), changes() returns 0
    const inserted = db.query<{ c: number }, []>("SELECT changes() as c").get()!.c;
    if (inserted === 0) return;

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
        [chunkId, new Uint8Array(embedding.buffer)]
      );
    }
  });

  tx();
  return turnId;
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
    .all(new Uint8Array(queryEmbedding.buffer), sessionId ? topK * 10 : topK * 3);

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
