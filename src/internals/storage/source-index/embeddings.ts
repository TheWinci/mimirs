import type { Database } from "bun:sqlite";

import type { EmbeddingIdentity } from "../../embeddings/embedder.ts";
import {
  createSourceVectorTable,
  SOURCE_EMBEDDING_DIRTY_GROUP_TABLE,
  SOURCE_EMBEDDING_INPUT_TABLE,
  SOURCE_EMBEDDING_POLICY_TABLE,
  SOURCE_VECTOR_TABLE,
} from "../schema.ts";
import type {
  CountRow,
  EmbeddingCandidateRow,
  EmbeddingStateRow,
  VectorSpaceRow,
} from "../rows.ts";
import type {
  SourceWindowEmbeddingCandidatePage,
  SourceWindowEmbeddingCursor,
  SourceWindowEmbeddingStatePage,
  SourceWindowEmbeddingWrite,
} from "../types.ts";
import {
  embeddingBytes,
  validEmbeddingIdentity,
} from "../encoding.ts";
import { tableExists } from "./database.ts";

export class EmbeddingRepository {
  constructor(private readonly database: Database) {}

  dimensions(): number | null {
    return this.database.query<VectorSpaceRow, []>(
      "SELECT dimensions FROM source_vector_space WHERE id = 1",
    ).get()?.dimensions ?? null;
  }

  prepareSpace(identity: EmbeddingIdentity): void {
    validEmbeddingIdentity(identity);
    if (
      this.dimensions() === identity.dimensions &&
      tableExists(this.database, SOURCE_VECTOR_TABLE)
    ) {
      return;
    }
    this.replaceSpace(identity.dimensions);
  }

  resetSpace(identity: EmbeddingIdentity): void {
    validEmbeddingIdentity(identity);
    this.replaceSpace(identity.dimensions);
  }

  countVectors(): number {
    if (!tableExists(this.database, SOURCE_VECTOR_TABLE)) return 0;
    return this.database.query<CountRow, []>(
      `SELECT count(*) AS count FROM ${SOURCE_VECTOR_TABLE}`,
    ).get()?.count ?? 0;
  }

  hasVectors(): boolean {
    if (!tableExists(this.database, SOURCE_VECTOR_TABLE)) return false;
    return this.database.query<{ present: number }, []>(
      `SELECT 1 AS present FROM ${SOURCE_VECTOR_TABLE} LIMIT 1`,
    ).get() !== null;
  }

  countCandidates(identity: EmbeddingIdentity): number {
    validEmbeddingIdentity(identity);
    const hasVectors = this.compatibleVectorTable(identity);
    return this.database.query<CountRow, []>(
      `SELECT count(*) AS count
       FROM source_windows w
       ${hasVectors ? `LEFT JOIN ${SOURCE_VECTOR_TABLE} v ON v.window_id = w.id` : ""}
       WHERE ${hasVectors ? "v.window_id IS NULL" : "1 = 1"}`,
    ).get()?.count ?? 0;
  }

  readCandidatePage(
    identity: EmbeddingIdentity,
    limit: number,
    after: SourceWindowEmbeddingCursor | null = null,
  ): SourceWindowEmbeddingCandidatePage {
    validEmbeddingIdentity(identity);
    validatePageLimit(limit, "candidate");
    const hasVectors = this.compatibleVectorTable(identity);
    const cursorFilter = after
      ? `AND (
           f.path > ? OR
           (f.path = ? AND w.start_offset > ?) OR
           (f.path = ? AND w.start_offset = ? AND w.id > ?)
         )`
      : "";
    const parameters = pageParameters(after, limit);
    const rows = this.database.query<EmbeddingCandidateRow, any[]>(
      `SELECT w.id, f.path, w.start_offset, w.text, w.text_hash,
              c.kind AS chunk_kind, c.name AS chunk_name
       FROM source_windows w
       JOIN source_chunks c ON c.id = w.source_chunk_id
       JOIN files f ON f.id = c.file_id
       ${hasVectors ? `LEFT JOIN ${SOURCE_VECTOR_TABLE} v ON v.window_id = w.id` : ""}
       WHERE ${hasVectors ? "v.window_id IS NULL" : "1 = 1"}
       ${cursorFilter}
       ORDER BY f.path, w.start_offset, w.id
       LIMIT ?`,
    ).all(...parameters);
    const candidates = rows.map((row) => ({
      id: row.id,
      path: row.path,
      text: row.text,
      textHash: row.text_hash,
      sourceChunkKind: row.chunk_kind,
      sourceChunkName: row.chunk_name,
    }));
    return {
      candidates,
      nextCursor: nextCursor(rows),
    };
  }

  countInputMetadata(): number {
    return this.database.query<CountRow, []>(
      `SELECT count(*) AS count FROM ${SOURCE_EMBEDDING_INPUT_TABLE}`,
    ).get()?.count ?? 0;
  }

  inputPolicy(): string | null {
    return this.database.query<{ identity: string }, []>(
      `SELECT identity FROM ${SOURCE_EMBEDDING_POLICY_TABLE} WHERE id = 1`,
    ).get()?.identity ?? null;
  }

  setInputPolicy(identity: string): void {
    if (identity === "") throw new Error("embedding input policy is empty");
    this.database.query(
      `INSERT INTO ${SOURCE_EMBEDDING_POLICY_TABLE}(id, identity)
       VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET identity = excluded.identity`,
    ).run(identity);
  }

  hasDirtyInputGroups(): boolean {
    return this.database.query<{ present: number }, []>(
      `SELECT 1 AS present
       FROM ${SOURCE_EMBEDDING_DIRTY_GROUP_TABLE}
       LIMIT 1`,
    ).get() !== null;
  }

  clearDirtyInputGroups(): void {
    this.database.exec(`DELETE FROM ${SOURCE_EMBEDDING_DIRTY_GROUP_TABLE}`);
  }

  readStatePage(
    identity: EmbeddingIdentity,
    limit: number,
    after: SourceWindowEmbeddingCursor | null = null,
  ): SourceWindowEmbeddingStatePage {
    validEmbeddingIdentity(identity);
    validatePageLimit(limit, "state");
    const hasVectors = this.compatibleVectorTable(identity);
    const cursorFilter = after
      ? `WHERE (
           f.path > ? OR
           (f.path = ? AND w.start_offset > ?) OR
           (f.path = ? AND w.start_offset = ? AND w.id > ?)
         )`
      : "";
    const parameters = pageParameters(after, limit);
    const rows = this.database.query<EmbeddingStateRow, any[]>(
      `SELECT w.id, f.path, w.start_offset, w.text, w.text_hash,
              c.kind AS chunk_kind, c.name AS chunk_name,
              ${hasVectors
                ? "CASE WHEN v.window_id IS NULL THEN 0 ELSE 1 END"
                : "0"} AS has_vector,
              i.base_input_hash, i.effective_input_hash,
              i.path_disambiguated
       FROM source_windows w
       JOIN source_chunks c ON c.id = w.source_chunk_id
       JOIN files f ON f.id = c.file_id
       ${hasVectors
         ? `LEFT JOIN ${SOURCE_VECTOR_TABLE} v ON v.window_id = w.id`
         : ""}
       LEFT JOIN ${SOURCE_EMBEDDING_INPUT_TABLE} i ON i.window_id = w.id
       ${cursorFilter}
       ORDER BY f.path, w.start_offset, w.id
       LIMIT ?`,
    ).all(...parameters);
    const candidates = rows.map((row) => ({
      id: row.id,
      path: row.path,
      text: row.text,
      textHash: row.text_hash,
      sourceChunkKind: row.chunk_kind,
      sourceChunkName: row.chunk_name,
      hasVector: row.has_vector === 1,
      baseInputHash: row.base_input_hash,
      effectiveInputHash: row.effective_input_hash,
      pathDisambiguated: row.path_disambiguated === null
        ? null
        : row.path_disambiguated === 1,
    }));
    return {
      candidates,
      nextCursor: nextCursor(rows),
    };
  }

  invalidateWindows(windowIds: readonly number[]): void {
    if (windowIds.length === 0) return;
    if (!windowIds.every((id) => Number.isSafeInteger(id) && id > 0)) {
      throw new RangeError("embedding window ids must be positive integers");
    }
    const ids = JSON.stringify(windowIds);
    this.database.transaction(() => {
      if (tableExists(this.database, SOURCE_VECTOR_TABLE)) {
        this.database.query(
          `DELETE FROM ${SOURCE_VECTOR_TABLE}
           WHERE window_id IN (SELECT value FROM json_each(?))`,
        ).run(ids);
      }
      this.database.query(
        `DELETE FROM ${SOURCE_EMBEDDING_INPUT_TABLE}
         WHERE window_id IN (SELECT value FROM json_each(?))`,
      ).run(ids);
    }).immediate();
  }

  store(
    identity: EmbeddingIdentity,
    embeddings: readonly SourceWindowEmbeddingWrite[],
  ): void {
    validEmbeddingIdentity(identity);
    validateEmbeddingWrites(identity, embeddings);
    this.prepareSpace(identity);
    const rows = embeddings.map((value) => {
      const row = this.database.query<{ present: number }, [number, string]>(
        `SELECT 1 AS present
         FROM source_windows
         WHERE id = ? AND text_hash = ?`,
      ).get(value.windowId, value.textHash);
      if (!row) {
        throw new Error(
          `source window ${value.windowId} changed while it was being embedded`,
        );
      }
      return value;
    });
    const remove = this.database.query(
      `DELETE FROM ${SOURCE_VECTOR_TABLE} WHERE window_id = ?`,
    );
    const insert = this.database.query(
      `INSERT INTO ${SOURCE_VECTOR_TABLE}(window_id, embedding) VALUES (?, ?)`,
    );
    const removeInput = this.database.query(
      `DELETE FROM ${SOURCE_EMBEDDING_INPUT_TABLE} WHERE window_id = ?`,
    );
    const upsertInput = this.database.query(
      `INSERT INTO ${SOURCE_EMBEDDING_INPUT_TABLE}
         (window_id, base_input_hash, effective_input_hash, path_disambiguated)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(window_id) DO UPDATE SET
         base_input_hash = excluded.base_input_hash,
         effective_input_hash = excluded.effective_input_hash,
         path_disambiguated = excluded.path_disambiguated`,
    );
    this.database.transaction(() => {
      for (const value of rows) {
        remove.run(value.windowId);
        insert.run(value.windowId, embeddingBytes(value.vector));
        if (value.baseInputHash === undefined) {
          removeInput.run(value.windowId);
        } else {
          upsertInput.run(
            value.windowId,
            value.baseInputHash,
            value.effectiveInputHash!,
            Number(value.pathDisambiguated),
          );
        }
      }
    }).immediate();
  }

  private compatibleVectorTable(identity: EmbeddingIdentity): boolean {
    return this.dimensions() === identity.dimensions &&
      tableExists(this.database, SOURCE_VECTOR_TABLE);
  }

  private replaceSpace(dimensions: number): void {
    this.database.transaction(() => {
      this.database.exec(`DROP TABLE IF EXISTS ${SOURCE_VECTOR_TABLE}`);
      this.database.exec("DELETE FROM source_vector_space");
      this.database.exec(`DELETE FROM ${SOURCE_EMBEDDING_INPUT_TABLE}`);
      this.database.exec(`DELETE FROM ${SOURCE_EMBEDDING_DIRTY_GROUP_TABLE}`);
      this.database.exec(`DELETE FROM ${SOURCE_EMBEDDING_POLICY_TABLE}`);
      createSourceVectorTable(this.database, dimensions);
    }).immediate();
  }
}

function validatePageLimit(limit: number, kind: "candidate" | "state"): void {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError(`embedding ${kind} page limit must be positive`);
  }
}

function pageParameters(
  after: SourceWindowEmbeddingCursor | null,
  limit: number,
): Array<string | number> {
  return after
    ? [
        after.path,
        after.path,
        after.startOffset,
        after.path,
        after.startOffset,
        after.id,
        limit,
      ]
    : [limit];
}

function nextCursor(
  rows: readonly { id: number; path: string; start_offset: number }[],
): SourceWindowEmbeddingCursor | null {
  const last = rows.at(-1);
  return last
    ? { path: last.path, startOffset: last.start_offset, id: last.id }
    : null;
}

function validateEmbeddingWrites(
  identity: EmbeddingIdentity,
  embeddings: readonly SourceWindowEmbeddingWrite[],
): void {
  for (const value of embeddings) {
    if (!(value.vector instanceof Float32Array)) {
      throw new TypeError(
        `source window ${value.windowId} vector is not a Float32Array`,
      );
    }
    if (value.vector.length !== identity.dimensions) {
      throw new Error(
        `source window ${value.windowId} vector has ${value.vector.length} ` +
          `dimensions; expected ${identity.dimensions}`,
      );
    }
    if (value.vector.some((component) => !Number.isFinite(component))) {
      throw new Error(
        `source window ${value.windowId} vector contains a non-finite value`,
      );
    }
    const metadata = [
      value.baseInputHash,
      value.effectiveInputHash,
      value.pathDisambiguated,
    ];
    const provided = metadata.filter((component) => component !== undefined).length;
    if (provided !== 0 && provided !== metadata.length) {
      throw new Error(
        `source window ${value.windowId} embedding input metadata is incomplete`,
      );
    }
    if (
      value.baseInputHash !== undefined &&
      (value.baseInputHash === "" || value.effectiveInputHash === "")
    ) {
      throw new Error(
        `source window ${value.windowId} embedding input hash is empty`,
      );
    }
  }
}
