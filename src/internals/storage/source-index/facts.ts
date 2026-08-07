import type { Database } from "bun:sqlite";

import {
  sameEmbeddingIdentity,
  type EmbeddingIdentity,
} from "../../embeddings/embedder.ts";
import { projectFactDocuments } from "../../source/fact-documents.ts";
import type { AnalyzedSourceFile } from "../../source/relationships.ts";
import {
  createFactVectorTable,
  FACT_DOCUMENT_TABLE,
  FACT_VECTOR_SPACE_TABLE,
  FACT_VECTOR_TABLE,
} from "../schema.ts";
import type {
  FactCandidateRead,
  FactEmbeddingCandidatePage,
  FactEmbeddingCursor,
  FactEmbeddingWrite,
} from "../types.ts";
import {
  embeddingBytes,
  sha256,
  sourceChunkRefKey,
  validEmbeddingIdentity,
} from "../encoding.ts";
import { tableExists } from "./database.ts";

interface FactSpaceRow extends EmbeddingIdentity {}

interface StoredDocumentRow {
  id: number;
  owner_chunk_id: number | null;
  ordinal: number;
  start_offset: number;
  text: string;
  text_hash: string;
}

interface DocumentRow extends StoredDocumentRow {
  path: string;
}

interface ChunkIdentityRow {
  id: number;
  kind: Parameters<typeof sourceChunkRefKey>[0]["kind"];
  name: string | null;
  start_offset: number;
  end_offset: number;
  start_line: number;
  end_line: number;
}

export interface FactDocumentSyncSummary {
  files: number;
  changedFiles: number;
  unchangedFiles: number;
  documents: number;
}

export class FactRepository {
  constructor(private readonly database: Database) {}

  synchronize(files: readonly AnalyzedSourceFile[]): FactDocumentSyncSummary {
    let changedFiles = 0;
    let unchangedFiles = 0;
    for (const file of [...files].sort((left, right) =>
      left.path.localeCompare(right.path)
    )) {
      const fileId = this.database.query<{ id: number }, [string]>(
        "SELECT id FROM files WHERE path = ?",
      ).get(file.path)?.id;
      if (fileId === undefined) {
        throw new Error(`cannot project facts for missing file ${file.path}`);
      }
      const chunkIds = new Map<string, number>();
      for (const row of this.database.query<ChunkIdentityRow, [number]>(
        `SELECT id, kind, name, start_offset, end_offset, start_line, end_line
         FROM source_chunks
         WHERE file_id = ? AND name IS NOT NULL
         ORDER BY id`,
      ).all(fileId)) {
        chunkIds.set(sourceChunkRefKey({
          kind: row.kind,
          name: row.name!,
          startOffset: row.start_offset,
          endOffset: row.end_offset,
          startLine: row.start_line,
          endLine: row.end_line,
        }), row.id);
      }
      const desired = projectFactDocuments(file.path, file.result.facts).documents
        .map((document, ordinal) => ({
          ownerChunkId: document.owner === null
            ? null
            : chunkIds.get(sourceChunkRefKey(document.owner)),
          ordinal,
          startOffset: document.startOffset,
          text: document.text,
          textHash: sha256(document.text),
        }));
      if (desired.some((document) => document.ownerChunkId === undefined)) {
        throw new Error(`fact document owner is missing for ${file.path}`);
      }
      const existing = this.database.query<StoredDocumentRow, [number]>(
        `SELECT id, owner_chunk_id, ordinal, start_offset, text, text_hash
         FROM ${FACT_DOCUMENT_TABLE}
         WHERE file_id = ?
         ORDER BY ordinal`,
      ).all(fileId);
      const unchanged = existing.length === desired.length &&
        existing.every((document, index) => {
          const expected = desired[index]!;
          return document.owner_chunk_id === expected.ownerChunkId &&
            document.ordinal === expected.ordinal &&
            document.start_offset === expected.startOffset &&
            document.text === expected.text &&
            document.text_hash === expected.textHash;
        });
      if (unchanged) {
        unchangedFiles++;
        continue;
      }
      this.database.transaction(() => {
        if (tableExists(this.database, FACT_VECTOR_TABLE)) {
          this.database.query(
            `DELETE FROM ${FACT_VECTOR_TABLE}
             WHERE document_id IN (
               SELECT id FROM ${FACT_DOCUMENT_TABLE} WHERE file_id = ?
             )`,
          ).run(fileId);
        }
        this.database.query(
          `DELETE FROM ${FACT_DOCUMENT_TABLE} WHERE file_id = ?`,
        ).run(fileId);
        const insert = this.database.query(
          `INSERT INTO ${FACT_DOCUMENT_TABLE}
             (file_id, owner_chunk_id, ordinal, start_offset, text, text_hash)
           VALUES (?, ?, ?, ?, ?, ?)`,
        );
        for (const document of desired) {
          insert.run(
            fileId,
            document.ownerChunkId ?? null,
            document.ordinal,
            document.startOffset,
            document.text,
            document.textHash,
          );
        }
      }).immediate();
      changedFiles++;
    }
    return {
      files: files.length,
      changedFiles,
      unchangedFiles,
      documents: this.countDocuments(),
    };
  }

  countDocuments(): number {
    return this.database.query<{ count: number }, []>(
      `SELECT count(*) AS count FROM ${FACT_DOCUMENT_TABLE}`,
    ).get()?.count ?? 0;
  }

  countVectors(): number {
    if (!tableExists(this.database, FACT_VECTOR_TABLE)) return 0;
    return this.database.query<{ count: number }, []>(
      `SELECT count(*) AS count FROM ${FACT_VECTOR_TABLE}`,
    ).get()?.count ?? 0;
  }

  prepareSpace(identity: EmbeddingIdentity): void {
    validEmbeddingIdentity(identity);
    const current = this.space();
    if (
      current !== null && sameEmbeddingIdentity(current, identity) &&
      tableExists(this.database, FACT_VECTOR_TABLE)
    ) {
      return;
    }
    this.replaceSpace(identity);
  }

  countCandidates(identity: EmbeddingIdentity): number {
    validEmbeddingIdentity(identity);
    const compatible = this.compatible(identity);
    return this.database.query<{ count: number }, []>(
      `SELECT count(*) AS count
       FROM ${FACT_DOCUMENT_TABLE} d
       ${compatible
         ? `LEFT JOIN ${FACT_VECTOR_TABLE} v ON v.document_id = d.id`
         : ""}
       WHERE ${compatible ? "v.document_id IS NULL" : "1 = 1"}`,
    ).get()?.count ?? 0;
  }

  readCandidatePage(
    identity: EmbeddingIdentity,
    limit: number,
    after: FactEmbeddingCursor | null = null,
  ): FactEmbeddingCandidatePage {
    validEmbeddingIdentity(identity);
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new RangeError("fact embedding candidate page limit must be positive");
    }
    const compatible = this.compatible(identity);
    const cursor = after
      ? `AND (
           f.path > ? OR
           (f.path = ? AND d.start_offset > ?) OR
           (f.path = ? AND d.start_offset = ? AND d.id > ?)
         )`
      : "";
    const parameters: Array<string | number> = after
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
    const rows = this.database.query<DocumentRow, any[]>(
      `SELECT d.id, f.path, d.owner_chunk_id, d.ordinal, d.start_offset,
              d.text, d.text_hash
       FROM ${FACT_DOCUMENT_TABLE} d
       JOIN files f ON f.id = d.file_id
       ${compatible
         ? `LEFT JOIN ${FACT_VECTOR_TABLE} v ON v.document_id = d.id`
         : ""}
       WHERE ${compatible ? "v.document_id IS NULL" : "1 = 1"}
       ${cursor}
       ORDER BY f.path, d.start_offset, d.id
       LIMIT ?`,
    ).all(...parameters);
    const candidates = rows.map((row) => ({
      id: row.id,
      path: row.path,
      ownerChunkId: row.owner_chunk_id,
      startOffset: row.start_offset,
      text: row.text,
      textHash: row.text_hash,
    }));
    const last = candidates.at(-1);
    return {
      candidates,
      nextCursor: last
        ? { path: last.path, startOffset: last.startOffset, id: last.id }
        : null,
    };
  }

  store(
    identity: EmbeddingIdentity,
    embeddings: readonly FactEmbeddingWrite[],
  ): void {
    validEmbeddingIdentity(identity);
    this.prepareSpace(identity);
    for (const value of embeddings) {
      if (!(value.vector instanceof Float32Array)) {
        throw new TypeError(
          `fact document ${value.documentId} vector is not a Float32Array`,
        );
      }
      if (
        value.vector.length !== identity.dimensions ||
        value.vector.some((component) => !Number.isFinite(component))
      ) {
        throw new Error(`fact document ${value.documentId} vector is invalid`);
      }
      const current = this.database.query<{ present: number }, [number, string]>(
        `SELECT 1 AS present FROM ${FACT_DOCUMENT_TABLE}
         WHERE id = ? AND text_hash = ?`,
      ).get(value.documentId, value.textHash);
      if (!current) {
        throw new Error(
          `fact document ${value.documentId} changed while it was being embedded`,
        );
      }
    }
    const remove = this.database.query(
      `DELETE FROM ${FACT_VECTOR_TABLE} WHERE document_id = ?`,
    );
    const insert = this.database.query(
      `INSERT INTO ${FACT_VECTOR_TABLE}(document_id, embedding) VALUES (?, ?)`,
    );
    this.database.transaction(() => {
      for (const value of embeddings) {
        remove.run(value.documentId);
        insert.run(value.documentId, embeddingBytes(value.vector));
      }
    }).immediate();
  }

  readCandidates(
    identity: EmbeddingIdentity,
    queryVector: Float32Array,
    limit: number,
  ): FactCandidateRead {
    validEmbeddingIdentity(identity);
    if (queryVector.length !== identity.dimensions) {
      throw new Error("fact query vector dimensions are incompatible");
    }
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new RangeError("fact candidate limit must be positive");
    }
    const total = this.countDocuments();
    const embedded = this.countVectors();
    if (!this.compatible(identity)) {
      return { candidates: [], diagnostics: { total, embedded, compatible: false } };
    }
    if (embedded === 0) {
      return { candidates: [], diagnostics: { total, embedded, compatible: true } };
    }
    const rows = this.database.query<DocumentRow & { distance: number }, [
      Uint8Array,
      number,
    ]>(
      `WITH nearest AS (
         SELECT document_id, distance
         FROM ${FACT_VECTOR_TABLE}
         WHERE embedding MATCH ? AND k = ?
       )
       SELECT d.id, f.path, d.owner_chunk_id, d.ordinal, d.start_offset,
              d.text, d.text_hash, nearest.distance
       FROM nearest
       JOIN ${FACT_DOCUMENT_TABLE} d ON d.id = nearest.document_id
       JOIN files f ON f.id = d.file_id
       ORDER BY nearest.distance, f.path, d.start_offset, d.id`,
    ).all(embeddingBytes(queryVector), Math.min(limit, embedded));
    return {
      candidates: rows.map((row) => ({
        id: row.id,
        path: row.path,
        ownerChunkId: row.owner_chunk_id,
        startOffset: row.start_offset,
        text: row.text,
        textHash: row.text_hash,
        score: 1 - row.distance,
      })),
      diagnostics: { total, embedded, compatible: true },
    };
  }

  private space(): FactSpaceRow | null {
    return this.database.query<FactSpaceRow, []>(
      `SELECT model, revision, variant, dimensions
       FROM ${FACT_VECTOR_SPACE_TABLE} WHERE id = 1`,
    ).get();
  }

  private compatible(identity: EmbeddingIdentity): boolean {
    const current = this.space();
    return current !== null && sameEmbeddingIdentity(current, identity) &&
      tableExists(this.database, FACT_VECTOR_TABLE);
  }

  private replaceSpace(identity: EmbeddingIdentity): void {
    this.database.transaction(() => {
      this.database.exec(`DROP TABLE IF EXISTS ${FACT_VECTOR_TABLE}`);
      this.database.exec(`DELETE FROM ${FACT_VECTOR_SPACE_TABLE}`);
      createFactVectorTable(this.database, identity.dimensions);
      this.database.query(
        `INSERT INTO ${FACT_VECTOR_SPACE_TABLE}
           (id, model, revision, variant, dimensions)
         VALUES (1, ?, ?, ?, ?)`,
      ).run(identity.model, identity.revision, identity.variant, identity.dimensions);
    }).immediate();
  }
}
