import type {
  SourceChunkKind,
} from "@winci/bun-chunk";
import type {
  Embedder,
} from "../embeddings/embedder.ts";
import {
  type DocumentSearchRelation,
} from "./document-search.ts";
import {
  type NativeLexicalMode,
  type SemanticCandidateDiagnostics,
} from "../storage/source-index.ts";

export interface SearchRequest {
  query: string;
  maxResults: number;
}
export interface SearchRange {
  startOffset: number;
  endOffset: number;
  startLine: number;
  endLine: number;
}
export interface SearchWindowRange extends SearchRange {
  id: number;
}
export interface SearchSourceChunk extends SearchRange {
  id: number;
  kind: SourceChunkKind;
  name: string | null;
}
export interface SearchHit {
  windowId: number;
  path: string;
  score: number;
  semanticScore: number;
  lexicalScore: number;
  preview: string;
  /** Ordered ranges from every source window merged into this file result. */
  windows: SearchWindowRange[];
  /** Primary source window retained for compact previews and compatibility. */
  window: SearchRange;
  /** Ordered ranges from every source chunk merged into this file result. */
  sourceChunks: SearchSourceChunk[];
  /** Primary source chunk retained for compact previews and compatibility. */
  sourceChunk: SearchSourceChunk;
}
export interface SearchDiagnostics extends SemanticCandidateDiagnostics {
  unscorableCandidates: number;
  lexicalCandidates: number;
}
export interface SearchResponse {
  source: SearchHit[];
  docs: SearchHit[];
  relations: DocumentSearchRelation[];
  diagnostics: SearchDiagnostics;
}
export interface SearchCandidateResponse {
  results: SearchHit[];
  diagnostics: SearchDiagnostics;
}
export interface SearchOptions {
  embedder?: Embedder;
  previewCharacters?: number;
  /** Internal correctness oracle; production search uses SQLite-native candidates. */
  engine?: "native" | "exact";
  /** Internal benchmark seam; public search uses the measured default of 100. */
  candidateLimit?: number;
  /** Internal benchmark seam; production uses the measured semantic depth. */
  semanticCandidateLimit?: number;
  /** Internal benchmark seam; production completes both channel scores. */
  completeMissingCandidateScores?: boolean;
  /** Internal experiment: complete semantic scores for lexical candidates. */
  completeMissingSemanticScores?: boolean;
  /** Internal experiment: complete lexical scores for semantic candidates. */
  completeMissingLexicalScores?: boolean;
  /** Internal benchmark seam; production fuses evidence by chunk and file. */
  candidateAggregation?: "window" | "chunk-file" | "anchored-file";
  /** Internal benchmark seam; production uses 25% secondary confirmation. */
  fileConfirmationWeight?: number;
  /** Maximum confirmation bonus relative to the production-anchored score. */
  fileBonusCap?: number;
  /** Internal benchmark/tuning seam; public search uses the measured default. */
  semanticWeight?: number;
  /** Internal ablation seam; production uses the measured 1.20 signal. */
  exactNameMultiplier?: number;
  /** Internal tuning seam; production confirms unique definition names. */
  uniqueSymbolMultiplier?: number;
  /** Internal tuning seam; production demotes conventional test paths. */
  testPathMultiplier?: number;
  /** Project policy: searchable generated files receive a measured demotion. */
  generatedPatterns?: readonly string[];
  /** Internal tuning seam for configured generated-file demotion. */
  generatedPathMultiplier?: number;
  /** Internal ablation seam for v1's zero-based RRF convention. */
  fusionConvention?: "current" | "v1";
  /** Internal ablation seam; public search uses the current FTS projection. */
  lexicalMode?: NativeLexicalMode;
}
