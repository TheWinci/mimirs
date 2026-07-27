import type { Database } from "bun:sqlite";

import {
  SOURCE_EMBEDDING_DIRTY_GROUP_TABLE,
  SOURCE_EMBEDDING_INPUT_TABLE,
  SOURCE_VECTOR_TABLE,
} from "../schema.ts";
import { tableExists } from "./database.ts";
import type { FileRepository } from "./files.ts";
import type { LexicalIndex } from "./lexical.ts";

export class FileReconciler {
  constructor(
    private readonly database: Database,
    private readonly files: FileRepository,
    private readonly lexicalIndex: LexicalIndex,
  ) {}

  /**
   * Make persisted files match one successfully discovered project view.
   * Remove external FTS and vec0 projections before the relational cascade.
   */
  reconcile(paths: ReadonlySet<string>): string[] {
    const removed = this.files.list().filter((file) => !paths.has(file.path));
    if (removed.length === 0) return [];
    const fileIds = removed.map((file) => file.id);
    const encodedFileIds = JSON.stringify(fileIds);

    this.database.transaction(() => {
      this.database.query(
        `INSERT OR IGNORE INTO ${SOURCE_EMBEDDING_DIRTY_GROUP_TABLE}
           (base_input_hash)
         SELECT DISTINCT i.base_input_hash
         FROM ${SOURCE_EMBEDDING_INPUT_TABLE} i
         JOIN source_windows w ON w.id = i.window_id
         JOIN source_chunks c ON c.id = w.source_chunk_id
         WHERE c.file_id IN (SELECT value FROM json_each(?))`,
      ).run(encodedFileIds);
      this.lexicalIndex.deleteFileWindows(fileIds);
      if (tableExists(this.database, SOURCE_VECTOR_TABLE)) {
        this.database.query(
          `DELETE FROM ${SOURCE_VECTOR_TABLE}
           WHERE window_id IN (
             SELECT w.id
             FROM source_windows w
             JOIN source_chunks c ON c.id = w.source_chunk_id
             WHERE c.file_id IN (SELECT value FROM json_each(?))
           )`,
        ).run(encodedFileIds);
      }
      this.files.deleteRowsByIds(fileIds);
    }).immediate();

    return removed.map((file) => file.path);
  }
}
