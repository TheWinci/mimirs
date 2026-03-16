/** A chunk with its computed embedding, ready for DB insertion. */
export interface EmbeddedChunk {
  snippet: string;
  embedding: Float32Array;
  entityName?: string | null;
  chunkType?: string | null;
  startLine?: number | null;
  endLine?: number | null;
  contentHash?: string | null;
  parentId?: number | null;
}
