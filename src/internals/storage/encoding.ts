import {
  normalize,
  type SourceChunk,
  type SourceChunkKind,
  type SourceChunkRef,
} from "@winci/bun-chunk";
import type {
  EmbeddingIdentity,
} from "../embeddings/embedder.ts";
import {
  lexicalTerms,
} from "../search/lexical-search.ts";
import type {
  IndexedFile,
  StoredSourceEmbedding,
  NativeWindowCandidate,
  NativeLexicalMode,
} from "./types.ts";
import type {
  FileRow,
  WindowRow,
  NativeCandidateRow,
} from "./rows.ts";

export function sha256(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}
export function embeddingBytes(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
}
export function nativeWindowCandidate(row: NativeCandidateRow): NativeWindowCandidate {
  return {
    id: row.window_id,
    path: row.path,
    text: row.window_text,
    startOffset: row.window_start_offset,
    endOffset: row.window_end_offset,
    startLine: row.window_start_line,
    endLine: row.window_end_line,
    sourceChunk: {
      id: row.chunk_id,
      kind: row.chunk_kind,
      name: row.chunk_name,
      startOffset: row.chunk_start_offset,
      endOffset: row.chunk_end_offset,
      startLine: row.chunk_start_line,
      endLine: row.chunk_end_line,
    },
    semanticScore: row.semantic_score,
    lexicalScore: row.lexical_score,
  };
}
export function ftsQuery(
  value: string,
  mode: NativeLexicalMode = "current",
): string | null {
  const terms = mode === "v1-like"
    ? [...new Set(value.split(/\s+/).filter(Boolean))]
    : [...new Set(lexicalTerms(value))];
  return terms.length === 0
    ? null
    : terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
}
export function embeddingVector(bytes: Uint8Array, dimensions: number): Float32Array {
  if (bytes.byteLength !== dimensions * Float32Array.BYTES_PER_ELEMENT) {
    throw new Error(
      `source index contains a ${bytes.byteLength}-byte embedding for ` +
        `${dimensions} dimensions`,
    );
  }
  const copy = bytes.slice();
  return new Float32Array(copy.buffer, copy.byteOffset, dimensions);
}
export function cosineScore(
  left: Float32Array,
  right: Float32Array,
): number | null {
  let dot = 0;
  let leftSquared = 0;
  let rightSquared = 0;
  for (let index = 0; index < left.length; index++) {
    dot += left[index]! * right[index]!;
    leftSquared += left[index]! * left[index]!;
    rightSquared += right[index]! * right[index]!;
  }
  return leftSquared === 0 || rightSquared === 0
    ? null
    : dot / Math.sqrt(leftSquared * rightSquared);
}
export function validEmbeddingIdentity(identity: EmbeddingIdentity): void {
  for (const field of ["model", "revision", "variant"] as const) {
    if (identity[field].trim() === "") {
      throw new Error(`embedding identity ${field} must not be empty`);
    }
  }
  if (!Number.isSafeInteger(identity.dimensions) || identity.dimensions <= 0) {
    throw new RangeError("embedding identity dimensions must be a positive integer");
  }
}
export function storedEmbedding(
  row: WindowRow,
  dimensions: number | null,
): StoredSourceEmbedding | null {
  if (row.embedding === null) return null;
  if (dimensions === null) throw new Error("source vector dimensions are missing");
  return {
    dimensions,
    vector: embeddingVector(row.embedding, dimensions),
  };
}
/** Hash the exact normalized text against which chunk/window ranges are stated. */
export function sourceContentHash(source: string): string {
  return sha256(normalize(source));
}
export function indexedFile(row: FileRow): IndexedFile {
  return {
    id: row.id,
    path: row.path,
    language: row.language,
    strategy: row.strategy,
    contentHash: row.content_hash,
    analysisVersion: row.analysis_version,
    windowTarget: row.window_target,
    opaque: row.opaque,
  };
}
export function sourceChunkRefKey(ref: SourceChunkRef): string {
  return [
    ref.kind,
    ref.name,
    ref.startOffset,
    ref.endOffset,
    ref.startLine,
    ref.endLine,
  ].join("\0");
}
export function sourceChunkKey(chunk: SourceChunk): string | null {
  return chunk.name === null
    ? null
    : sourceChunkRefKey({
        kind: chunk.kind,
        name: chunk.name,
        startOffset: chunk.startOffset,
        endOffset: chunk.endOffset,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
      });
}
export function sourceFactRef(
  id: number | null,
  kind: SourceChunkKind | null,
  name: string | null,
  startOffset: number | null,
  endOffset: number | null,
  startLine: number | null,
  endLine: number | null,
): SourceChunkRef | null {
  if (id === null) return null;
  if (
    kind === null || name === null || startOffset === null ||
    endOffset === null || startLine === null || endLine === null
  ) {
    throw new Error(`source index contains an incomplete chunk reference: ${id}`);
  }
  return { kind, name, startOffset, endOffset, startLine, endLine };
}
