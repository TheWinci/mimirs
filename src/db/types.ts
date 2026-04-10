export interface StoredChunk {
  id: number;
  fileId: number;
  chunkIndex: number;
  snippet: string;
  entityName: string | null;
  chunkType: string | null;
  startLine: number | null;
  endLine: number | null;
  parentId: number | null;
}

export interface StoredFile {
  id: number;
  path: string;
  hash: string;
  indexedAt: string;
}

export interface SearchResult {
  path: string;
  score: number;
  snippet: string;
  chunkIndex: number;
  entityName: string | null;
  chunkType: string | null;
}

export interface ChunkSearchResult {
  path: string;
  score: number;
  content: string;
  chunkIndex: number;
  entityName: string | null;
  chunkType: string | null;
  startLine: number | null;
  endLine: number | null;
  parentId: number | null;
}

export interface UsageResult {
  path: string;
  line: number | null;
  snippet: string;
}

export interface AnnotationRow {
  id: number;
  path: string;
  symbolName: string | null;
  note: string;
  author: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SymbolResult {
  path: string;
  symbolName: string;
  symbolType: string;
  snippet: string | null;
  chunkIndex: number | null;
}

export interface CheckpointRow {
  id: number;
  sessionId: string;
  turnIndex: number;
  timestamp: string;
  type: string;
  title: string;
  summary: string;
  filesInvolved: string[];
  tags: string[];
}

export interface GitCommitRow {
  id: number;
  hash: string;
  shortHash: string;
  message: string;
  authorName: string;
  authorEmail: string;
  date: string;
  filesChanged: string[];
  insertions: number;
  deletions: number;
  isMerge: boolean;
  refs: string[];
  diffSummary: string | null;
}

export interface GitCommitSearchResult extends GitCommitRow {
  score: number;
}

export interface ConversationSearchResult {
  turnId: number;
  turnIndex: number;
  sessionId: string;
  timestamp: string;
  summary: string;
  snippet: string;
  toolsUsed: string[];
  filesReferenced: string[];
  score: number;
}
