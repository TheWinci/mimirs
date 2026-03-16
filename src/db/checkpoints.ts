import { Database } from "bun:sqlite";
import { type CheckpointRow } from "./types";

export function createCheckpoint(
  db: Database,
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

  const tx = db.transaction(() => {
    db.run(
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
        null,
      ]
    );

    checkpointId = Number(
      db.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!.id
    );

    db.run(
      "INSERT INTO vec_checkpoints (checkpoint_id, embedding) VALUES (?, ?)",
      [checkpointId, new Uint8Array(embedding.buffer)]
    );
  });

  tx();
  return checkpointId;
}

export function listCheckpoints(
  db: Database,
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

  return db
    .query<
      { id: number; session_id: string; turn_index: number; timestamp: string; type: string; title: string; summary: string; files_involved: string; tags: string },
      (string | number)[]
    >(sql)
    .all(...params)
    .map((r) => ({
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

export function searchCheckpoints(
  db: Database,
  queryEmbedding: Float32Array,
  topK: number = 5,
  type?: string
): (CheckpointRow & { score: number })[] {
  const rows = db
    .query<
      {
        checkpoint_id: number;
        distance: number;
        id: number;
        session_id: string;
        turn_index: number;
        timestamp: string;
        type: string;
        title: string;
        summary: string;
        files_involved: string;
        tags: string;
      },
      [Uint8Array, number]
    >(
      `SELECT v.checkpoint_id, v.distance,
              cp.id, cp.session_id, cp.turn_index, cp.timestamp, cp.type,
              cp.title, cp.summary, cp.files_involved, cp.tags
       FROM (SELECT checkpoint_id, distance FROM vec_checkpoints WHERE embedding MATCH ? ORDER BY distance LIMIT ?) v
       JOIN conversation_checkpoints cp ON cp.id = v.checkpoint_id`
    )
    .all(new Uint8Array(queryEmbedding.buffer), topK * 2);

  const results: (CheckpointRow & { score: number })[] = [];

  for (const row of rows) {
    if (type && row.type !== type) continue;

    results.push({
      id: row.id,
      sessionId: row.session_id,
      turnIndex: row.turn_index,
      timestamp: row.timestamp,
      type: row.type,
      title: row.title,
      summary: row.summary,
      filesInvolved: JSON.parse(row.files_involved || "[]"),
      tags: JSON.parse(row.tags || "[]"),
      score: 1 / (1 + row.distance),
    });

    if (results.length >= topK) break;
  }

  return results;
}

export function getCheckpoint(db: Database, id: number): CheckpointRow | null {
  const r = db
    .query<
      { id: number; session_id: string; turn_index: number; timestamp: string; type: string; title: string; summary: string; files_involved: string; tags: string },
      [number]
    >(
      "SELECT id, session_id, turn_index, timestamp, type, title, summary, files_involved, tags FROM conversation_checkpoints WHERE id = ?"
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
