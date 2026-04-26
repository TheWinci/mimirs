import { Database } from "bun:sqlite";
import { type AnnotationRow } from "./types";

export function upsertAnnotation(
  db: Database,
  path: string,
  note: string,
  embedding: Float32Array,
  symbolName?: string | null,
  author?: string | null
): number {
  let annotationId = 0;

  const tx = db.transaction(() => {
    let existing: { id: number; note: string } | null = null;
    if (symbolName) {
      existing = db
        .query<{ id: number; note: string }, [string, string]>(
          "SELECT id, note FROM annotations WHERE path = ? AND symbol_name = ?"
        )
        .get(path, symbolName);
    } else {
      existing = db
        .query<{ id: number; note: string }, [string]>(
          "SELECT id, note FROM annotations WHERE path = ? AND symbol_name IS NULL"
        )
        .get(path);
    }

    const now = new Date().toISOString();

    if (existing) {
      db.run(
        "INSERT INTO fts_annotations(fts_annotations, rowid, note) VALUES ('delete', ?, ?)",
        [existing.id, existing.note]
      );
      db.run(
        "UPDATE annotations SET note = ?, author = ?, updated_at = ? WHERE id = ?",
        [note, author ?? null, now, existing.id]
      );
      db.run("INSERT INTO fts_annotations(rowid, note) VALUES (?, ?)", [existing.id, note]);
      db.run("DELETE FROM vec_annotations WHERE annotation_id = ?", [existing.id]);
      db.run(
        "INSERT INTO vec_annotations (annotation_id, embedding) VALUES (?, ?)",
        [existing.id, new Uint8Array(embedding.buffer)]
      );
      annotationId = existing.id;
    } else {
      db.run(
        "INSERT INTO annotations (path, symbol_name, note, author, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        [path, symbolName ?? null, note, author ?? null, now, now]
      );
      annotationId = Number(
        db.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!.id
      );
      db.run("INSERT INTO fts_annotations(rowid, note) VALUES (?, ?)", [annotationId, note]);
      db.run(
        "INSERT INTO vec_annotations (annotation_id, embedding) VALUES (?, ?)",
        [annotationId, new Uint8Array(embedding.buffer)]
      );
    }
  });

  tx();
  return annotationId;
}

/**
 * Batch-fetch annotations for many paths in a single SQL pass. Returns
 * raw rows including `path` so the caller can group per file. Empty input
 * returns empty output. Used by the wiki bundle builder.
 */
export function getAnnotationsForPaths(db: Database, paths: string[]): AnnotationRow[] {
  if (paths.length === 0) return [];
  const BATCH = 499;
  const out: AnnotationRow[] = [];
  for (let i = 0; i < paths.length; i += BATCH) {
    const batch = paths.slice(i, i + BATCH);
    const ph = batch.map(() => "?").join(",");
    const rows = db
      .query<
        { id: number; path: string; symbol_name: string | null; note: string; author: string | null; created_at: string; updated_at: string },
        string[]
      >(`SELECT * FROM annotations WHERE path IN (${ph}) ORDER BY updated_at DESC`)
      .all(...batch);
    for (const r of rows) {
      out.push({
        id: r.id,
        path: r.path,
        symbolName: r.symbol_name,
        note: r.note,
        author: r.author,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      });
    }
  }
  return out;
}

export function getAnnotations(db: Database, path?: string, symbolName?: string | null): AnnotationRow[] {
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

  return db
    .query<
      { id: number; path: string; symbol_name: string | null; note: string; author: string | null; created_at: string; updated_at: string },
      (string | null)[]
    >(sql)
    .all(...params)
    .map((r) => ({
      id: r.id,
      path: r.path,
      symbolName: r.symbol_name,
      note: r.note,
      author: r.author,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
}

export function searchAnnotations(
  db: Database,
  queryEmbedding: Float32Array,
  topK: number = 10
): (AnnotationRow & { score: number })[] {
  return db
    .query<
      {
        annotation_id: number;
        distance: number;
        id: number;
        path: string;
        symbol_name: string | null;
        note: string;
        author: string | null;
        created_at: string;
        updated_at: string;
      },
      [Uint8Array, number]
    >(
      `SELECT v.annotation_id, v.distance,
              a.id, a.path, a.symbol_name, a.note, a.author, a.created_at, a.updated_at
       FROM (SELECT annotation_id, distance FROM vec_annotations WHERE embedding MATCH ? ORDER BY distance LIMIT ?) v
       JOIN annotations a ON a.id = v.annotation_id`
    )
    .all(new Uint8Array(queryEmbedding.buffer), topK)
    .map((row) => ({
      id: row.id,
      path: row.path,
      symbolName: row.symbol_name,
      note: row.note,
      author: row.author,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      score: 1 / (1 + row.distance),
    }));
}

export function deleteAnnotation(db: Database, id: number): boolean {
  const existing = db
    .query<{ id: number; note: string }, [number]>(
      "SELECT id, note FROM annotations WHERE id = ?"
    )
    .get(id);
  if (!existing) return false;

  const tx = db.transaction(() => {
    db.run(
      "INSERT INTO fts_annotations(fts_annotations, rowid, note) VALUES ('delete', ?, ?)",
      [id, existing.note]
    );
    db.run("DELETE FROM vec_annotations WHERE annotation_id = ?", [id]);
    db.run("DELETE FROM annotations WHERE id = ?", [id]);
  });

  tx();
  return true;
}
