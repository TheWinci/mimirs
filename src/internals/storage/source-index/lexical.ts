import type { Database } from "bun:sqlite";

import { lexicalTerms } from "../../search/lexical-search.ts";
import type { CountRow, LexicalSourceRow } from "../rows.ts";
import {
  SOURCE_INDEX_SCHEMA_VERSION,
  SOURCE_PROJECTION_VERSION_TABLE,
} from "../schema.ts";

const LEXICAL_PROJECTION = "source_windows_fts";

export class LexicalIndex {
  constructor(private readonly database: Database) {}

  /** Insert one projection row inside the transaction that the caller owns. */
  insertWindow(
    id: number,
    path: string,
    chunkName: string | null,
    text: string,
  ): void {
    this.database.query(
      `INSERT INTO source_windows_fts(rowid, path, chunk_name, text)
       VALUES (?, ?, ?, ?)`,
    ).run(
      id,
      lexicalText(path),
      lexicalText(chunkName),
      lexicalText(text),
    );
  }

  /** Delete projection rows inside the transaction that the caller owns. */
  deleteFileWindows(fileIds: readonly number[]): void {
    if (fileIds.length === 0) return;
    this.database.query(
      `DELETE FROM source_windows_fts
       WHERE rowid IN (
         SELECT w.id
         FROM source_windows w
         JOIN source_chunks c ON c.id = w.source_chunk_id
         WHERE c.file_id IN (SELECT value FROM json_each(?))
       )`,
    ).run(JSON.stringify(fileIds));
  }

  synchronize(): void {
    const windows = this.database.query<CountRow, []>(
      "SELECT count(*) AS count FROM source_windows",
    ).get()?.count ?? 0;
    const indexed = this.database.query<CountRow, []>(
      "SELECT count(*) AS count FROM source_windows_fts",
    ).get()?.count ?? 0;
    const projectionVersion = this.database.query<
      { schema_version: number },
      [string]
    >(
      `SELECT schema_version
       FROM ${SOURCE_PROJECTION_VERSION_TABLE}
       WHERE name = ?`,
    ).get(LEXICAL_PROJECTION)?.schema_version;
    if (
      windows === indexed &&
      projectionVersion === SOURCE_INDEX_SCHEMA_VERSION
    ) {
      return;
    }

    const rows = this.database.query<LexicalSourceRow, []>(
      `SELECT w.id, f.path, c.name AS chunk_name, w.text
       FROM source_windows w
       JOIN source_chunks c ON c.id = w.source_chunk_id
       JOIN files f ON f.id = c.file_id
       ORDER BY w.id`,
    ).all();
    this.database.transaction(() => {
      this.database.exec(
        `INSERT INTO source_windows_fts(source_windows_fts)
         VALUES ('delete-all')`,
      );
      for (const row of rows) {
        this.insertWindow(row.id, row.path, row.chunk_name, row.text);
      }
      this.database.query(
        `INSERT INTO ${SOURCE_PROJECTION_VERSION_TABLE}(name, schema_version)
         VALUES (?, ?)
         ON CONFLICT(name) DO UPDATE SET
           schema_version = excluded.schema_version`,
      ).run(LEXICAL_PROJECTION, SOURCE_INDEX_SCHEMA_VERSION);
    }).immediate();
  }
}

function lexicalText(value: string | null): string {
  return lexicalTerms(value ?? "").join(" ");
}
