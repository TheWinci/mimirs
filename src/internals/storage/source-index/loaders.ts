import type { Database } from "bun:sqlite";

import type {
  CallFact,
  ExportFact,
  ImportFact,
  SourceChunk,
  SourceFact,
} from "@winci/bun-chunk";

import type { AnalyzedSourceFile } from "../../source/relationships.ts";
import { SOURCE_VECTOR_TABLE } from "../schema.ts";
import type {
  ChunkRow,
  FactRow,
  RootTextRow,
  StoredChunkNode,
  WindowRow,
} from "../rows.ts";
import type { IndexedSourceWindow } from "../types.ts";
import {
  sourceFactRef,
  storedEmbedding,
} from "../encoding.ts";
import { tableExists } from "./database.ts";
import type { EmbeddingRepository } from "./embeddings.ts";
import type { FileRepository } from "./files.ts";

export class AnalysisLoader {
  constructor(
    private readonly database: Database,
    private readonly files: FileRepository,
    private readonly embeddings: EmbeddingRepository,
  ) {}

  loadChunks(path: string): SourceChunk[] {
    const rows = this.database.query<ChunkRow, [string]>(
      `SELECT c.id, c.parent_id, c.ordinal, c.kind, c.name,
              c.start_offset, c.end_offset, c.start_line, c.end_line
       FROM source_chunks c
       JOIN files f ON f.id = c.file_id
       WHERE f.path = ?
       ORDER BY c.id`,
    ).all(path);
    const nodes = new Map<number, StoredChunkNode>();
    for (const row of rows) {
      nodes.set(row.id, {
        id: row.id,
        parentId: row.parent_id,
        ordinal: row.ordinal,
        chunk: {
          kind: row.kind,
          name: row.name,
          startOffset: row.start_offset,
          endOffset: row.end_offset,
          startLine: row.start_line,
          endLine: row.end_line,
          children: [],
        },
        children: [],
      });
    }

    const roots: StoredChunkNode[] = [];
    for (const node of nodes.values()) {
      if (node.parentId === null) {
        roots.push(node);
        continue;
      }
      const parent = nodes.get(node.parentId);
      if (!parent) {
        throw new Error(
          `source index contains a missing parent chunk: ${node.parentId}`,
        );
      }
      parent.children.push(node);
    }

    const rootTexts = new Map<number, string>();
    const textRows = this.database.query<RootTextRow, [string]>(
      `SELECT w.source_chunk_id, w.ordinal, w.text
       FROM source_windows w
       JOIN source_chunks c ON c.id = w.source_chunk_id
       JOIN files f ON f.id = c.file_id
       WHERE f.path = ?
       ORDER BY w.source_chunk_id, w.ordinal`,
    ).all(path);
    for (const row of textRows) {
      rootTexts.set(
        row.source_chunk_id,
        (rootTexts.get(row.source_chunk_id) ?? "") + row.text,
      );
    }

    roots.sort((left, right) => left.ordinal - right.ordinal);
    return roots.map((root) => {
      const rootText = rootTexts.get(root.id);
      // A whitespace-only or otherwise non-retrievable structural chunk can
      // legitimately project to zero source windows. Its graph identity and
      // byte range still matter even though its text was not persisted.
      return materializeChunk(root, root, rootText ?? "");
    });
  }

  loadFacts(path: string): SourceFact[] {
    const rows = this.database.query<FactRow, [string]>(
      `SELECT
         sf.kind AS fact_kind,
         sf.start_offset, sf.end_offset, sf.start_line, sf.end_line,
         sf.source, sf.imported, sf.local, sf.type_only,
         sf.static, sf.global, sf.exported, sf.callee, sf.binding,
         sf.owner_chunk_id,
         owner.kind AS owner_kind,
         owner.name AS owner_name,
         owner.start_offset AS owner_start_offset,
         owner.end_offset AS owner_end_offset,
         owner.start_line AS owner_start_line,
         owner.end_line AS owner_end_line,
         sf.target_chunk_id,
         target.kind AS target_kind,
         target.name AS target_name,
         target.start_offset AS target_start_offset,
         target.end_offset AS target_end_offset,
         target.start_line AS target_start_line,
         target.end_line AS target_end_line
       FROM source_facts sf
       JOIN files f ON f.id = sf.file_id
       LEFT JOIN source_chunks owner ON owner.id = sf.owner_chunk_id
       LEFT JOIN source_chunks target ON target.id = sf.target_chunk_id
       WHERE f.path = ?
       ORDER BY sf.ordinal`,
    ).all(path);
    return rows.map(materializeFact);
  }

  loadFile(path: string): AnalyzedSourceFile | null {
    const file = this.files.get(path);
    if (!file) return null;
    return {
      path,
      result: {
        language: file.language,
        chunks: this.loadChunks(path),
        facts: this.loadFacts(path),
      },
    };
  }

  loadFiles(): AnalyzedSourceFile[] {
    return this.files.list().map((file) => {
      const analyzed = this.loadFile(file.path);
      if (!analyzed) {
        throw new Error(`indexed file disappeared: ${file.path}`);
      }
      return analyzed;
    });
  }

  loadWindows(path: string): IndexedSourceWindow[] {
    const dimensions = this.embeddings.dimensions();
    const hasVectors = dimensions !== null &&
      tableExists(this.database, SOURCE_VECTOR_TABLE);
    const rows = this.database.query<WindowRow, [string]>(
      `SELECT
         w.id AS window_id,
         w.source_chunk_id,
         w.start_offset AS window_start_offset,
         w.end_offset AS window_end_offset,
         w.start_line AS window_start_line,
         w.end_line AS window_end_line,
         w.text AS window_text,
         w.text_hash AS window_text_hash,
         ${hasVectors ? "v.embedding" : "NULL"} AS embedding,
         f.path,
         c.kind AS chunk_kind,
         c.name AS chunk_name,
         c.start_offset AS chunk_start_offset,
         c.end_offset AS chunk_end_offset,
         c.start_line AS chunk_start_line,
         c.end_line AS chunk_end_line
       FROM source_windows w
       ${hasVectors ? `LEFT JOIN ${SOURCE_VECTOR_TABLE} v ON v.window_id = w.id` : ""}
       JOIN source_chunks c ON c.id = w.source_chunk_id
       JOIN files f ON f.id = c.file_id
       WHERE f.path = ?
       ORDER BY c.start_offset, w.ordinal`,
    ).all(path);

    const owners = new Map<number, SourceChunk>();
    return rows.map((row) => {
      let sourceChunk = owners.get(row.source_chunk_id);
      if (!sourceChunk) {
        sourceChunk = {
          kind: row.chunk_kind,
          name: row.chunk_name,
          text: "",
          startOffset: row.chunk_start_offset,
          endOffset: row.chunk_end_offset,
          startLine: row.chunk_start_line,
          endLine: row.chunk_end_line,
          children: [],
        };
        owners.set(row.source_chunk_id, sourceChunk);
      }
      sourceChunk.text += row.window_text;
      return {
        id: row.window_id,
        sourceChunkId: row.source_chunk_id,
        textHash: row.window_text_hash,
        embedding: storedEmbedding(row, dimensions),
        path: row.path,
        sourceChunk,
        text: row.window_text,
        startOffset: row.window_start_offset,
        endOffset: row.window_end_offset,
        startLine: row.window_start_line,
        endLine: row.window_end_line,
      };
    });
  }
}

function materializeChunk(
  node: StoredChunkNode,
  root: StoredChunkNode,
  rootText: string,
): SourceChunk {
  node.children.sort((left, right) => left.ordinal - right.ordinal);
  node.chunk.children = node.children.map((child) =>
    materializeChunk(child, root, rootText)
  );
  if (node.children.length === 0) {
    node.chunk.text = rootText.slice(
      node.chunk.startOffset - root.chunk.startOffset,
      node.chunk.endOffset - root.chunk.startOffset,
    );
  }
  return node.chunk;
}

function materializeFact(row: FactRow): SourceFact {
  const owner = sourceFactRef(
    row.owner_chunk_id,
    row.owner_kind,
    row.owner_name,
    row.owner_start_offset,
    row.owner_end_offset,
    row.owner_start_line,
    row.owner_end_line,
  );
  const base = {
    startOffset: row.start_offset,
    endOffset: row.end_offset,
    startLine: row.start_line,
    endLine: row.end_line,
    owner,
  };

  if (row.fact_kind === "import") {
    if (row.source === null) {
      throw new Error("source index contains an import without a source");
    }
    const fact: ImportFact = {
      ...base,
      kind: "import",
      source: row.source,
      imported: row.imported,
      local: row.local,
      typeOnly: row.type_only === 1,
      static: row.static === 1,
      global: row.global === 1,
    };
    return fact;
  }
  if (row.fact_kind === "export") {
    if (row.exported === null) {
      throw new Error("source index contains an export without a name");
    }
    const fact: ExportFact = {
      ...base,
      kind: "export",
      exported: row.exported,
      local: row.local,
      source: row.source,
      typeOnly: row.type_only === 1,
    };
    return fact;
  }
  if (row.callee === null || row.binding === null) {
    throw new Error("source index contains an incomplete call");
  }
  const fact: CallFact = {
    ...base,
    kind: "call",
    callee: row.callee,
    binding: row.binding,
    target: sourceFactRef(
      row.target_chunk_id,
      row.target_kind,
      row.target_name,
      row.target_start_offset,
      row.target_end_offset,
      row.target_start_line,
      row.target_end_line,
    ),
  };
  return fact;
}
