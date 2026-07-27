import {
  SourceIndex,
} from "../../storage/source-index.ts";
import type {
  Definition,
  CitedSourceWindow,
  CitedWindowRow,
} from "./types.ts";

export function overlaps(window: CitedSourceWindow, definition: Definition): boolean {
  return window.sourceChunk.startOffset <= definition.startOffset &&
    window.sourceChunk.endOffset >= definition.endOffset;
}

export function citedWindows(
  index: SourceIndex,
  paths: readonly string[],
): Map<string, CitedSourceWindow[]> {
  const uniquePaths = [...new Set(paths)];
  if (uniquePaths.length === 0) return new Map();
  const rows = index.database.query<CitedWindowRow, [string]>(
    `SELECT w.id, f.path, w.text,
            w.start_offset AS startOffset, w.end_offset AS endOffset,
            w.start_line AS startLine, w.end_line AS endLine,
            c.id AS sourceChunkId, c.kind AS sourceChunkKind,
            c.name AS sourceChunkName,
            c.start_offset AS sourceChunkStartOffset,
            c.end_offset AS sourceChunkEndOffset,
            c.start_line AS sourceChunkStartLine,
            c.end_line AS sourceChunkEndLine
     FROM source_windows w
     JOIN source_chunks c ON c.id = w.source_chunk_id
     JOIN files f ON f.id = c.file_id
     WHERE f.path IN (SELECT value FROM json_each(?))
     ORDER BY f.path, c.start_offset, w.ordinal`,
  ).all(JSON.stringify(uniquePaths));
  const windows = new Map<string, CitedSourceWindow[]>();
  for (const row of rows) {
    const values = windows.get(row.path) ?? [];
    values.push({
      id: row.id,
      path: row.path,
      text: row.text,
      startOffset: row.startOffset,
      endOffset: row.endOffset,
      startLine: row.startLine,
      endLine: row.endLine,
      sourceChunk: {
        id: row.sourceChunkId,
        kind: row.sourceChunkKind,
        name: row.sourceChunkName,
        startOffset: row.sourceChunkStartOffset,
        endOffset: row.sourceChunkEndOffset,
        startLine: row.sourceChunkStartLine,
        endLine: row.sourceChunkEndLine,
      },
    });
    windows.set(row.path, values);
  }
  return windows;
}
