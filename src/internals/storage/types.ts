import {
  type SourceChunkKind,
  type SourceChunkResult,
  type SourceChunkStrategy,
} from "@winci/bun-chunk";
import {
  type SourceWindow,
} from "../source/windows.ts";

export interface IndexedFile {
  id: number;
  path: string;
  language: SourceChunkResult["language"];
  strategy: SourceChunkStrategy;
  contentHash: string;
  analysisVersion: number;
  windowTarget: number;
  opaque: string | null;
}
export interface IndexFileResult {
  changed: boolean;
  file: IndexedFile;
  chunkCount: number;
  factCount: number;
  windowCount: number;
}
export interface IndexedSourceWindow extends SourceWindow {
  id: number;
  sourceChunkId: number;
  textHash: string;
  embedding: StoredSourceEmbedding | null;
}
export interface StoredSourceEmbedding {
  dimensions: number;
  vector: Float32Array;
}
export interface SourceWindowEmbeddingCandidate {
  id: number;
  path: string;
  text: string;
  textHash: string;
  sourceChunkKind: SourceChunkKind;
  sourceChunkName: string | null;
}
export interface SourceWindowEmbeddingCursor {
  path: string;
  startOffset: number;
  id: number;
}
export interface SourceWindowEmbeddingCandidatePage {
  candidates: SourceWindowEmbeddingCandidate[];
  nextCursor: SourceWindowEmbeddingCursor | null;
}
export interface SourceWindowEmbeddingStateCandidate
  extends SourceWindowEmbeddingCandidate {
  hasVector: boolean;
  baseInputHash: string | null;
  effectiveInputHash: string | null;
  pathDisambiguated: boolean | null;
}
export interface SourceWindowEmbeddingStatePage {
  candidates: SourceWindowEmbeddingStateCandidate[];
  nextCursor: SourceWindowEmbeddingCursor | null;
}
export interface SourceWindowEmbeddingWrite {
  windowId: number;
  textHash: string;
  vector: Float32Array;
  baseInputHash?: string;
  effectiveInputHash?: string;
  pathDisambiguated?: boolean;
}
export interface SemanticSourceChunk {
  id: number;
  kind: SourceChunkKind;
  name: string | null;
  startOffset: number;
  endOffset: number;
  startLine: number;
  endLine: number;
}
export interface SemanticWindowCandidate {
  id: number;
  path: string;
  text: string;
  textHash: string;
  startOffset: number;
  endOffset: number;
  startLine: number;
  endLine: number;
  sourceChunk: SemanticSourceChunk;
  vector: Float32Array;
}
export interface SemanticCandidateDiagnostics {
  total: number;
  compatible: number;
  missingEmbedding: number;
  incompleteEmbedding: number;
  incompatibleEmbedding: number;
  malformedEmbedding: number;
  orphaned: number;
}
export interface SemanticCandidateRead {
  candidates: SemanticWindowCandidate[];
  diagnostics: SemanticCandidateDiagnostics;
}
export interface NativeWindowCandidate {
  id: number;
  path: string;
  text: string;
  startOffset: number;
  endOffset: number;
  startLine: number;
  endLine: number;
  sourceChunk: SemanticSourceChunk;
  semanticScore: number;
  lexicalScore: number;
}
export interface NativeCandidateRead {
  diagnostics: SemanticCandidateDiagnostics;
  baselineSemantic: NativeWindowCandidate[];
  baselineLexical: NativeWindowCandidate[];
  semantic: NativeWindowCandidate[];
  lexical: NativeWindowCandidate[];
  unscorableCandidates: number;
  lexicalCandidates: number;
}
export type NativeLexicalMode = "current" | "text-only" | "v1-like";
export interface NativeCandidateOptions {
  /** Internal ablation seam; production uses the current normalized FTS view. */
  lexicalMode?: NativeLexicalMode;
  /** Internal tuning seam; defaults to the shared semantic/lexical limit. */
  semanticLimit?: number;
  /** Fill the missing channel score for every candidate in the retrieved union. */
  completeMissingScores?: boolean;
  /** Fill semantic scores only for lexical candidates outside the semantic list. */
  completeMissingSemanticScores?: boolean;
  /** Fill lexical scores only for semantic candidates outside the lexical list. */
  completeMissingLexicalScores?: boolean;
}
