import type { Database } from "bun:sqlite";

import type { FileRow } from "../rows.ts";
import type { IndexedFile } from "../types.ts";
import { indexedFile } from "../encoding.ts";

export class FileRepository {
  constructor(private readonly database: Database) {}

  get(path: string): IndexedFile | null {
    const row = this.database.query<FileRow, [string]>(
      `SELECT id, path, language, strategy, content_hash,
              analysis_version, window_target, opaque
       FROM files
       WHERE path = ?`,
    ).get(path);
    return row ? indexedFile(row) : null;
  }

  list(): IndexedFile[] {
    return this.database.query<FileRow, []>(
      `SELECT id, path, language, strategy, content_hash,
              analysis_version, window_target, opaque
       FROM files
       ORDER BY path`,
    ).all().map(indexedFile);
  }

  /** Delete file rows inside the transaction that the caller owns. */
  deleteRowsByIds(fileIds: readonly number[]): void {
    if (fileIds.length === 0) return;
    this.database.query(
      "DELETE FROM files WHERE id IN (SELECT value FROM json_each(?))",
    ).run(JSON.stringify(fileIds));
  }
}
