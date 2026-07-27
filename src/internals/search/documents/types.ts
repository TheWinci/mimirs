import type {
  SourceChunkKind,
} from "@winci/bun-chunk";
import type {
  SearchHit,
  SearchRange,
  SearchSourceChunk,
} from "../search.ts";

export type DocumentReferenceKind = "path" | "qualified-symbol";
export interface DocumentSearchRelation {
  documentWindowId: number;
  documentPath: string;
  documentRange: SearchRange;
  sourceWindowId: number;
  sourcePath: string;
  sourceRange: SearchRange | null;
  reference: string;
  symbol: string | null;
  kind: DocumentReferenceKind;
  inheritedScore: number;
}
export interface SegmentedSearchResults {
  source: SearchHit[];
  docs: SearchHit[];
  relations: DocumentSearchRelation[];
}
export interface ExtractedReference {
  value: string;
  kind: DocumentReferenceKind;
}
export interface Definition {
  path: string;
  name: string;
  startOffset: number;
  endOffset: number;
  startLine: number;
  endLine: number;
}
export interface PendingReference {
  document: SearchHit;
  documentScore: number;
  reference: ExtractedReference;
}
export interface ResolvedReference {
  path: string;
  definition: Definition | null;
}
export interface CitedSourceWindow {
  id: number;
  path: string;
  text: string;
  startOffset: number;
  endOffset: number;
  startLine: number;
  endLine: number;
  sourceChunk: SearchSourceChunk;
}
export interface CitedWindowRow {
  id: number;
  path: string;
  text: string;
  startOffset: number;
  endOffset: number;
  startLine: number;
  endLine: number;
  sourceChunkId: number;
  sourceChunkKind: SourceChunkKind;
  sourceChunkName: string | null;
  sourceChunkStartOffset: number;
  sourceChunkEndOffset: number;
  sourceChunkStartLine: number;
  sourceChunkEndLine: number;
}
