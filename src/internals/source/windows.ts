import {
  textOf,
  type SourceChunk,
  type SourceSpan,
} from "@winci/bun-chunk";

export const DEFAULT_SOURCE_WINDOW_TARGET_CHARACTERS = 4_000;
export const DEFAULT_SOURCE_WINDOW_PREVIEW_CHARACTERS = 96;

/**
 * A contiguous embedding candidate derived from one top-level SourceChunk.
 *
 * The complete parent object is referenced deliberately: persisting this
 * projection can replace the object reference with a source-chunk row id
 * without copying the parent's range into every window.
 */
export interface SourceWindow extends SourceSpan {
  path: string;
  sourceChunk: SourceChunk;
  /** Complete verbatim text for the window's own range. */
  text: string;
}

export interface SourceWindowOptions {
  /**
   * Preferred maximum window size. Existing source-chunk and whole-line
   * boundaries win over this target, so one indivisible line may exceed it.
   */
  targetCharacters?: number;
}

interface Piece {
  startOffset: number;
  endOffset: number;
  meaningful: boolean;
  preferPrevious?: boolean;
}

function positiveInteger(value: number, option: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${option} must be a positive integer`);
  }
  return value;
}

function linePieces(
  chunk: SourceChunk,
  root: SourceChunk,
  rootText: string,
): Piece[] {
  const pieces: Piece[] = [];
  let cursor = chunk.startOffset - root.startOffset;
  const end = chunk.endOffset - root.startOffset;
  while (cursor < end) {
    const newline = rootText.indexOf("\n", cursor);
    const next = newline >= 0 && newline < end ? newline + 1 : end;
    const text = rootText.slice(cursor, next);
    pieces.push({
      startOffset: root.startOffset + cursor,
      endOffset: root.startOffset + next,
      meaningful: text.trim() !== "",
      preferPrevious: /^\s*[}\])]+[;,]?\s*$/.test(text),
    });
    cursor = next;
  }
  return pieces;
}

function boundaryPieces(
  chunk: SourceChunk,
  root: SourceChunk,
  rootText: string,
  targetCharacters: number,
): Piece[] {
  const length = chunk.endOffset - chunk.startOffset;
  if (length <= targetCharacters) {
    const start = chunk.startOffset - root.startOffset;
    const text = rootText.slice(start, start + length);
    return [{
      startOffset: chunk.startOffset,
      endOffset: chunk.endOffset,
      meaningful: chunk.kind !== "gap" && text.trim() !== "",
    }];
  }
  if (chunk.children.length > 0) {
    return chunk.children.flatMap((child) =>
      boundaryPieces(child, root, rootText, targetCharacters)
    );
  }
  return linePieces(chunk, root, rootText);
}

function groupPieces(pieces: Piece[], targetCharacters: number): Piece[] {
  const groups: Piece[] = [];
  let current: Piece | null = null;
  let pendingWhitespace: Piece | null = null;

  for (const piece of pieces) {
    const previousEnd = pendingWhitespace?.endOffset ?? current?.endOffset;
    if (previousEnd !== undefined && previousEnd !== piece.startOffset) {
      throw new Error("source-window pieces must be contiguous");
    }
    if (!piece.meaningful) {
      pendingWhitespace = pendingWhitespace
        ? {
            startOffset: pendingWhitespace.startOffset,
            endOffset: piece.endOffset,
            meaningful: false,
          }
        : { ...piece };
      continue;
    }

    const pieceStart = pendingWhitespace?.startOffset ?? piece.startOffset;
    if (
      current?.meaningful &&
      piece.endOffset - current.startOffset > targetCharacters &&
      !piece.preferPrevious
    ) {
      groups.push(current);
      current = {
        startOffset: pieceStart,
        endOffset: piece.endOffset,
        meaningful: true,
        preferPrevious: piece.preferPrevious,
      };
    } else {
      current = current
        ? {
            startOffset: current.startOffset,
            endOffset: piece.endOffset,
            meaningful: true,
            preferPrevious: current.preferPrevious && piece.preferPrevious,
          }
        : {
            startOffset: pieceStart,
            endOffset: piece.endOffset,
            meaningful: true,
            preferPrevious: piece.preferPrevious,
          };
    }
    pendingWhitespace = null;
  }

  if (current?.meaningful && pendingWhitespace) {
    current.endOffset = pendingWhitespace.endOffset;
  }
  if (current?.meaningful) {
    groups.push(current);
  }
  return groups;
}

function rootLineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function attachIndentationForward(
  groups: Piece[],
  root: SourceChunk,
  rootText: string,
): Piece[] {
  for (let index = 1; index < groups.length; index++) {
    const previous = groups[index - 1]!;
    const current = groups[index]!;
    const relativeBoundary = current.startOffset - root.startOffset;
    const lineStart = rootText.lastIndexOf("\n", relativeBoundary - 1) + 1;
    if (
      lineStart < relativeBoundary &&
      rootText.slice(lineStart, relativeBoundary).trim() === "" &&
      root.startOffset + lineStart > previous.startOffset
    ) {
      const boundary = root.startOffset + lineStart;
      previous.endOffset = boundary;
      current.startOffset = boundary;
    }
  }
  return groups;
}

function lineAt(
  root: SourceChunk,
  starts: number[],
  absoluteOffset: number,
): number {
  const relativeOffset = absoluteOffset - root.startOffset;
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle]! <= relativeOffset) low = middle;
    else high = middle - 1;
  }
  return root.startLine + low;
}

function windowsForChunk(
  path: string,
  sourceChunk: SourceChunk,
  targetCharacters: number,
): SourceWindow[] {
  const text = textOf(sourceChunk);
  const starts = rootLineStarts(text);
  const groups = attachIndentationForward(
    groupPieces(
      boundaryPieces(sourceChunk, sourceChunk, text, targetCharacters),
      targetCharacters,
    ),
    sourceChunk,
    text,
  );
  return groups.map((group) => {
    const relativeStart = group.startOffset - sourceChunk.startOffset;
    const relativeEnd = group.endOffset - sourceChunk.startOffset;
    return {
      path,
      sourceChunk,
      text: text.slice(relativeStart, relativeEnd),
      startOffset: group.startOffset,
      endOffset: group.endOffset,
      startLine: lineAt(sourceChunk, starts, group.startOffset),
      endLine: lineAt(
        sourceChunk,
        starts,
        Math.max(group.startOffset, group.endOffset - 1),
      ),
    };
  });
}

/**
 * Project reviewed source chunks into non-overlapping embedding windows.
 * Top-level whitespace gaps are deliberately omitted; whitespace inside a
 * meaningful parent remains verbatim so its windows reconstruct that parent.
 */
export function projectSourceWindows(
  path: string,
  chunks: SourceChunk[],
  options: SourceWindowOptions = {},
): SourceWindow[] {
  const targetCharacters = positiveInteger(
    options.targetCharacters ?? DEFAULT_SOURCE_WINDOW_TARGET_CHARACTERS,
    "targetCharacters",
  );
  return chunks.flatMap((chunk) =>
    chunk.kind === "gap"
      ? []
      : windowsForChunk(path, chunk, targetCharacters)
  );
}

/** Produce a compact single-line preview without changing retained text. */
export function sourceTextPreview(
  text: string,
  maxCharacters = DEFAULT_SOURCE_WINDOW_PREVIEW_CHARACTERS,
): string {
  positiveInteger(maxCharacters, "maxCharacters");
  const normalized = text.replace(/\s+/g, " ").trim();
  const characters = Array.from(normalized);
  if (characters.length <= maxCharacters) return normalized;
  if (maxCharacters === 1) return "…";
  return `${characters.slice(0, maxCharacters - 1).join("").trimEnd()}…`;
}

export function sourceWindowPreview(
  window: SourceWindow,
  maxCharacters = DEFAULT_SOURCE_WINDOW_PREVIEW_CHARACTERS,
): string {
  return sourceTextPreview(window.text, maxCharacters);
}
