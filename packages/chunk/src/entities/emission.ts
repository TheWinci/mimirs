import { offsetToRow } from "../source-text";
import type { SourceChunk, SourceChunkKind } from "../types";
import type { CommentNode, Entity } from "./types";

interface EmitContext {
  source: string;
  lineStarts: number[];
  comments: CommentNode[];
}

function makeChunk(
  context: EmitContext,
  kind: SourceChunkKind,
  name: string | null,
  start: number,
  end: number,
  children: SourceChunk[] = [],
): SourceChunk {
  return {
    kind,
    name,
    ...(children.length === 0
      ? { text: context.source.slice(start, end) }
      : {}),
    startOffset: start,
    endOffset: end,
    startLine: offsetToRow(context.lineStarts, start) + 1,
    endLine: offsetToRow(context.lineStarts, Math.max(start, end - 1)) + 1,
    children,
  };
}

function emitRemainder(
  context: EmitContext,
  start: number,
  end: number,
  output: SourceChunk[],
): void {
  if (start >= end) return;
  const kind: SourceChunkKind =
    context.source.slice(start, end).trim() === "" ? "gap" : "block";
  output.push(makeChunk(context, kind, null, start, end));
}

function emitFiller(
  context: EmitContext,
  start: number,
  end: number,
  output: SourceChunk[],
): void {
  if (start >= end) return;

  const comments = context.comments.filter((comment) =>
    comment.startOffset >= start && comment.endOffset <= end
  );
  const blocks: Array<{ start: number; end: number }> = [];
  for (const comment of comments) {
    const previous = blocks[blocks.length - 1];
    if (previous) {
      const between = context.source.slice(
        previous.end,
        comment.startOffset,
      );
      if (between.trim() === "" && !/\n[ \t]*\n/.test(between)) {
        previous.end = comment.endOffset;
        continue;
      }
    }
    blocks.push({ start: comment.startOffset, end: comment.endOffset });
  }

  let cursor = start;
  for (const block of blocks) {
    let blockEnd = block.end;
    let scan = blockEnd;
    while (
      scan < end &&
      context.source[scan] !== "\n" &&
      /[ \t]/.test(context.source[scan])
    ) {
      scan++;
    }
    if (scan < end && context.source[scan] === "\n") blockEnd = scan + 1;

    let blockStart = block.start;
    const row = offsetToRow(context.lineStarts, blockStart);
    const lineStart = context.lineStarts[row];
    if (
      lineStart >= cursor &&
      context.source.slice(lineStart, blockStart).trim() === ""
    ) {
      blockStart = lineStart;
    }

    if (blockStart > cursor) {
      emitRemainder(context, cursor, blockStart, output);
    }
    output.push(
      makeChunk(context, "comment", null, blockStart, blockEnd),
    );
    cursor = blockEnd;
  }
  if (cursor < end) emitRemainder(context, cursor, end, output);
}

function emitLevel(
  context: EmitContext,
  entities: Entity[],
  start: number,
  end: number,
): SourceChunk[] {
  const output: SourceChunk[] = [];
  let cursor = start;
  for (const entity of entities) {
    const entityStart = Math.max(entity.start, cursor);
    const entityEnd = Math.min(Math.max(entity.end, entityStart), end);
    if (entityEnd <= entityStart) continue;

    emitFiller(context, cursor, entityStart, output);

    let children: SourceChunk[] = [];
    const containsComment = context.comments.some((comment) =>
      comment.startOffset >= entityStart && comment.endOffset <= entityEnd
    );
    if (entity.children.length > 0 || containsComment) {
      children = emitLevel(
        context,
        entity.children,
        entityStart,
        entityEnd,
      );
    }
    output.push(
      makeChunk(
        context,
        entity.kind,
        entity.name,
        entityStart,
        entityEnd,
        children,
      ),
    );
    cursor = entityEnd;
  }
  emitFiller(context, cursor, end, output);
  return output;
}

export function emitChunks(
  source: string,
  lineStarts: number[],
  comments: CommentNode[],
  entities: Entity[],
): SourceChunk[] {
  if (source.length === 0) return [];
  return emitLevel(
    { source, lineStarts, comments },
    entities,
    0,
    source.length,
  );
}

export function chunkParagraphs(
  source: string,
  lineStarts: number[],
): SourceChunk[] {
  const context: EmitContext = { source, lineStarts, comments: [] };
  const chunks: SourceChunk[] = [];
  const blank = /^[ \t]*$/;
  const lines = source.split("\n");
  let cursor = 0;
  let row = 0;
  while (row < lines.length) {
    let scanRow = row;
    while (scanRow < lines.length && blank.test(lines[scanRow])) scanRow++;
    if (scanRow > row) {
      const gapEnd = scanRow < lines.length
        ? lineStarts[scanRow]
        : source.length;
      if (gapEnd > cursor) {
        chunks.push(makeChunk(context, "gap", null, cursor, gapEnd));
      }
      cursor = gapEnd;
      row = scanRow;
      continue;
    }

    while (scanRow < lines.length && !blank.test(lines[scanRow])) scanRow++;
    const paragraphEnd = scanRow < lines.length
      ? lineStarts[scanRow]
      : source.length;
    if (paragraphEnd > cursor) {
      chunks.push(
        makeChunk(context, "paragraph", null, cursor, paragraphEnd),
      );
    }
    cursor = paragraphEnd;
    row = scanRow;
  }
  if (cursor < source.length) {
    chunks.push(
      makeChunk(context, "gap", null, cursor, source.length),
    );
  }
  return chunks;
}
