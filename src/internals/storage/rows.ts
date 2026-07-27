import {
  chunk,
  type CallBindingKind,
  type SourceChunk,
  type SourceChunkKind,
  type SourceChunkResult,
  type SourceChunkStrategy,
  type SourceFact,
} from "@winci/bun-chunk";

export interface FileRow {
  id: number;
  path: string;
  language: SourceChunkResult["language"];
  strategy: SourceChunkStrategy;
  content_hash: string;
  analysis_version: number;
  window_target: number;
  opaque: string | null;
}
export interface CountRow {
  count: number;
}
export interface WindowRow {
  window_id: number;
  source_chunk_id: number;
  window_start_offset: number;
  window_end_offset: number;
  window_start_line: number;
  window_end_line: number;
  window_text: string;
  window_text_hash: string;
  embedding: Uint8Array | null;
  path: string;
  chunk_kind: SourceChunkKind;
  chunk_name: string | null;
  chunk_start_offset: number;
  chunk_end_offset: number;
  chunk_start_line: number;
  chunk_end_line: number;
}
export interface ChunkRow {
  id: number;
  parent_id: number | null;
  ordinal: number;
  kind: SourceChunkKind;
  name: string | null;
  start_offset: number;
  end_offset: number;
  start_line: number;
  end_line: number;
}
export interface RootTextRow {
  source_chunk_id: number;
  ordinal: number;
  text: string;
}
export interface FactRow {
  fact_kind: SourceFact["kind"];
  start_offset: number;
  end_offset: number;
  start_line: number;
  end_line: number;
  source: string | null;
  imported: string | null;
  local: string | null;
  type_only: number | null;
  static: number | null;
  global: number | null;
  exported: string | null;
  callee: string | null;
  binding: CallBindingKind | null;
  owner_chunk_id: number | null;
  owner_kind: SourceChunkKind | null;
  owner_name: string | null;
  owner_start_offset: number | null;
  owner_end_offset: number | null;
  owner_start_line: number | null;
  owner_end_line: number | null;
  target_chunk_id: number | null;
  target_kind: SourceChunkKind | null;
  target_name: string | null;
  target_start_offset: number | null;
  target_end_offset: number | null;
  target_start_line: number | null;
  target_end_line: number | null;
}
export interface StoredChunkNode {
  id: number;
  parentId: number | null;
  ordinal: number;
  chunk: SourceChunk;
  children: StoredChunkNode[];
}
export interface EmbeddingCandidateRow {
  id: number;
  path: string;
  start_offset: number;
  text: string;
  text_hash: string;
  chunk_kind: SourceChunkKind;
  chunk_name: string | null;
}
export interface EmbeddingStateRow extends EmbeddingCandidateRow {
  has_vector: number;
  base_input_hash: string | null;
  effective_input_hash: string | null;
  path_disambiguated: number | null;
}
export interface SemanticCandidateRow {
  window_id: number;
  window_start_offset: number;
  window_end_offset: number;
  window_start_line: number;
  window_end_line: number;
  window_text: string;
  window_text_hash: string;
  embedding: Uint8Array | null;
  path: string | null;
  chunk_id: number | null;
  chunk_kind: SourceChunkKind | null;
  chunk_name: string | null;
  chunk_start_offset: number | null;
  chunk_end_offset: number | null;
  chunk_start_line: number | null;
  chunk_end_line: number | null;
}
export interface VectorSpaceRow {
  dimensions: number;
}
export interface VectorMatchRow {
  window_id: number;
  distance: number | null;
}
export interface NativeScoreRow {
  window_id: number;
  score: number | null;
}
export interface NativeVectorRow {
  window_id: number;
  embedding: Uint8Array;
}
export interface NativeCandidateRow {
  window_id: number;
  path: string;
  window_text: string;
  window_start_offset: number;
  window_end_offset: number;
  window_start_line: number;
  window_end_line: number;
  chunk_id: number;
  chunk_kind: SourceChunkKind;
  chunk_name: string | null;
  chunk_start_offset: number;
  chunk_end_offset: number;
  chunk_start_line: number;
  chunk_end_line: number;
  semantic_score: number;
  lexical_score: number;
}
export interface LexicalSourceRow {
  id: number;
  path: string;
  chunk_name: string | null;
  text: string;
}
