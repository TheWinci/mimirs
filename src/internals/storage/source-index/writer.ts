import type { Database } from "bun:sqlite";

import {
  chunk,
  normalize,
  type CallBindingKind,
  type SourceChunk,
  type SourceChunkRef,
} from "@winci/bun-chunk";

import {
  DEFAULT_SOURCE_WINDOW_TARGET_CHARACTERS,
  projectSourceWindows,
  type SourceWindowOptions,
} from "../../source/windows.ts";
import {
  FACT_DOCUMENT_TABLE,
  FACT_VECTOR_TABLE,
  RELATION_DOCUMENT_TABLE,
  RELATION_VECTOR_TABLE,
  SOURCE_EMBEDDING_DIRTY_GROUP_TABLE,
  SOURCE_EMBEDDING_INPUT_TABLE,
  SOURCE_VECTOR_TABLE,
} from "../schema.ts";
import type { CountRow } from "../rows.ts";
import type { IndexFileResult } from "../types.ts";
import {
  sha256,
  sourceChunkKey,
  sourceChunkRefKey,
} from "../encoding.ts";
import { tableExists } from "./database.ts";
import type { FileRepository } from "./files.ts";
import type { LexicalIndex } from "./lexical.ts";

export const SOURCE_INDEX_ANALYSIS_VERSION = 2;

export class FileWriter {
  constructor(
    private readonly database: Database,
    private readonly files: FileRepository,
    private readonly lexicalIndex: LexicalIndex,
  ) {}

  async indexFile(
    path: string,
    source: string,
    options: SourceWindowOptions = {},
  ): Promise<IndexFileResult> {
    const windowTarget = options.targetCharacters ??
      DEFAULT_SOURCE_WINDOW_TARGET_CHARACTERS;
    if (!Number.isSafeInteger(windowTarget) || windowTarget <= 0) {
      throw new RangeError("targetCharacters must be a positive integer");
    }
    const normalized = normalize(source);
    const contentHash = sha256(normalized);
    const previous = this.files.get(path);
    if (
      previous?.contentHash === contentHash &&
      previous.analysisVersion === SOURCE_INDEX_ANALYSIS_VERSION &&
      previous.windowTarget === windowTarget
    ) {
      return {
        changed: false,
        file: previous,
        chunkCount: count(this.database, "source_chunks", previous.id),
        factCount: count(this.database, "source_facts", previous.id),
        windowCount: count(this.database, "source_windows", previous.id),
      };
    }

    const result = await chunk(path, normalized);
    if (result.binary) {
      throw new Error(`cannot index binary source file: ${path}`);
    }
    const windows = projectSourceWindows(path, result.chunks, {
      targetCharacters: windowTarget,
    });

    const indexed = this.database.transaction(() => {
      let fileId = previous?.id;
      if (fileId === undefined) {
        const inserted = this.database.query(
          `INSERT INTO files
             (path, language, strategy, content_hash, analysis_version,
              window_target, opaque)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          path,
          result.language,
          result.strategy,
          contentHash,
          SOURCE_INDEX_ANALYSIS_VERSION,
          windowTarget,
          result.opaque,
        );
        fileId = Number(inserted.lastInsertRowid);
      } else {
        this.database.query(
          `UPDATE files
           SET language = ?, strategy = ?, content_hash = ?,
               analysis_version = ?, window_target = ?, opaque = ?
           WHERE id = ?`,
        ).run(
          result.language,
          result.strategy,
          contentHash,
          SOURCE_INDEX_ANALYSIS_VERSION,
          windowTarget,
          result.opaque,
          fileId,
        );
        if (tableExists(this.database, FACT_VECTOR_TABLE)) {
          this.database.query(
            `DELETE FROM ${FACT_VECTOR_TABLE}
             WHERE document_id IN (
               SELECT id FROM ${FACT_DOCUMENT_TABLE} WHERE file_id = ?
             )`,
          ).run(fileId);
        }
        this.database.query(`DELETE FROM ${FACT_DOCUMENT_TABLE} WHERE file_id = ?`)
          .run(fileId);
        if (tableExists(this.database, RELATION_VECTOR_TABLE)) {
          this.database.query(
            `DELETE FROM ${RELATION_VECTOR_TABLE}
             WHERE document_id IN (
               SELECT id FROM ${RELATION_DOCUMENT_TABLE} WHERE file_id = ?
             )`,
          ).run(fileId);
        }
        this.database.query(
          `DELETE FROM ${RELATION_DOCUMENT_TABLE} WHERE file_id = ?`,
        ).run(fileId);
        this.database.query("DELETE FROM source_facts WHERE file_id = ?")
          .run(fileId);
        this.lexicalIndex.deleteFileWindows([fileId]);
        this.database.query(
          `INSERT OR IGNORE INTO ${SOURCE_EMBEDDING_DIRTY_GROUP_TABLE}
             (base_input_hash)
           SELECT DISTINCT i.base_input_hash
           FROM ${SOURCE_EMBEDDING_INPUT_TABLE} i
           JOIN source_windows w ON w.id = i.window_id
           JOIN source_chunks c ON c.id = w.source_chunk_id
           WHERE c.file_id = ?`,
        ).run(fileId);
        if (tableExists(this.database, SOURCE_VECTOR_TABLE)) {
          this.database.query(
            `DELETE FROM ${SOURCE_VECTOR_TABLE}
             WHERE window_id IN (
               SELECT w.id
               FROM source_windows w
               JOIN source_chunks c ON c.id = w.source_chunk_id
               WHERE c.file_id = ?
             )`,
          ).run(fileId);
        }
        this.database.query("DELETE FROM source_chunks WHERE file_id = ?")
          .run(fileId);
      }

      const chunkIds = new Map<SourceChunk, number>();
      const chunkRefIds = new Map<string, number>();
      const insertChunks = (
        chunks: SourceChunk[],
        parentId: number | null,
      ): void => {
        for (let ordinal = 0; ordinal < chunks.length; ordinal++) {
          const sourceChunk = chunks[ordinal]!;
          if (sourceChunk.kind === "gap") continue;
          const inserted = this.database.query(
            `INSERT INTO source_chunks
               (file_id, parent_id, ordinal, kind, name,
                start_offset, end_offset, start_line, end_line)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            fileId,
            parentId,
            ordinal,
            sourceChunk.kind,
            sourceChunk.name,
            sourceChunk.startOffset,
            sourceChunk.endOffset,
            sourceChunk.startLine,
            sourceChunk.endLine,
          );
          const chunkId = Number(inserted.lastInsertRowid);
          chunkIds.set(sourceChunk, chunkId);
          const key = sourceChunkKey(sourceChunk);
          if (key !== null) chunkRefIds.set(key, chunkId);
          insertChunks(sourceChunk.children, chunkId);
        }
      };
      insertChunks(result.chunks, null);

      const chunkIdForRef = (
        ref: SourceChunkRef | null,
        role: "owner" | "target",
      ): number | null => {
        if (ref === null) return null;
        const chunkId = chunkRefIds.get(sourceChunkRefKey(ref));
        if (chunkId === undefined) {
          throw new Error(`source fact ${role} was not persisted`);
        }
        return chunkId;
      };

      for (let ordinal = 0; ordinal < result.facts.length; ordinal++) {
        const fact = result.facts[ordinal]!;
        let source: string | null = null;
        let imported: string | null = null;
        let local: string | null = null;
        let typeOnly: number | null = null;
        let isStatic: number | null = null;
        let global: number | null = null;
        let exported: string | null = null;
        let callee: string | null = null;
        let binding: CallBindingKind | null = null;
        let targetChunkId: number | null = null;

        if (fact.kind === "import") {
          source = fact.source;
          imported = fact.imported;
          local = fact.local;
          typeOnly = Number(fact.typeOnly);
          isStatic = Number(fact.static);
          global = Number(fact.global);
        } else if (fact.kind === "export") {
          source = fact.source;
          exported = fact.exported;
          local = fact.local;
          typeOnly = Number(fact.typeOnly);
        } else {
          callee = fact.callee;
          binding = fact.binding;
          targetChunkId = chunkIdForRef(fact.target, "target");
        }

        this.database.query(
          `INSERT INTO source_facts
             (file_id, owner_chunk_id, target_chunk_id, ordinal, kind,
              start_offset, end_offset, start_line, end_line,
              source, imported, local, type_only, static, global,
              exported, callee, binding)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          fileId,
          chunkIdForRef(fact.owner, "owner"),
          targetChunkId,
          ordinal,
          fact.kind,
          fact.startOffset,
          fact.endOffset,
          fact.startLine,
          fact.endLine,
          source,
          imported,
          local,
          typeOnly,
          isStatic,
          global,
          exported,
          callee,
          binding,
        );
      }

      const windowOrdinals = new Map<number, number>();
      for (const window of windows) {
        const sourceChunkId = chunkIds.get(window.sourceChunk);
        if (sourceChunkId === undefined) {
          throw new Error("source window owner was not persisted");
        }
        const ordinal = windowOrdinals.get(sourceChunkId) ?? 0;
        windowOrdinals.set(sourceChunkId, ordinal + 1);
        const inserted = this.database.query(
          `INSERT INTO source_windows
             (source_chunk_id, ordinal, start_offset, end_offset,
              start_line, end_line, text, text_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          sourceChunkId,
          ordinal,
          window.startOffset,
          window.endOffset,
          window.startLine,
          window.endLine,
          window.text,
          sha256(window.text),
        );
        this.lexicalIndex.insertWindow(
          Number(inserted.lastInsertRowid),
          path,
          window.sourceChunk.name,
          window.text,
        );
      }

      const file = this.files.get(path);
      if (!file) throw new Error(`indexed file disappeared: ${path}`);
      return {
        changed: true,
        file,
        chunkCount: chunkIds.size,
        factCount: result.facts.length,
        windowCount: windows.length,
      };
    }).immediate();
    return indexed;
  }

}

function count(
  database: Database,
  table: "source_chunks" | "source_facts" | "source_windows",
  fileId: number,
): number {
  const join = table === "source_windows"
    ? "JOIN source_chunks c ON c.id = source_windows.source_chunk_id"
    : "";
  const fileColumn = table === "source_windows" ? "c.file_id" : "file_id";
  const row = database.query<CountRow, [number]>(
    `SELECT count(*) AS count FROM ${table} ${join} WHERE ${fileColumn} = ?`,
  ).get(fileId);
  return row?.count ?? 0;
}
