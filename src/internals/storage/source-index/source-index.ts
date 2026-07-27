import type { Database } from "bun:sqlite";

import type {
  SourceChunk,
  SourceFact,
} from "@winci/bun-chunk";

import type {
  SourceWindowOptions,
} from "../../source/windows.ts";
import type {
  EmbeddingIdentity,
} from "../../embeddings/embedder.ts";
import type {
  AnalyzedSourceFile,
} from "../../source/relationships.ts";
import type {
  IndexedFile,
  IndexFileResult,
  IndexedSourceWindow,
  StoredSourceEmbedding,
  SourceWindowEmbeddingCursor,
  SourceWindowEmbeddingCandidatePage,
  SourceWindowEmbeddingStatePage,
  SourceWindowEmbeddingWrite,
  SemanticWindowCandidate,
  SemanticCandidateDiagnostics,
  SemanticCandidateRead,
  NativeWindowCandidate,
  NativeCandidateRead,
  NativeLexicalMode,
  NativeCandidateOptions,
} from "../types.ts";
import {
  createSourceIndexDatabase,
  initializeSourceIndexDatabase,
} from "./database.ts";
import {
  LexicalIndex,
} from "./lexical.ts";
import {
  FileRepository,
} from "./files.ts";
import {
  FileReconciler,
} from "./reconcile.ts";
import {
  EmbeddingRepository,
} from "./embeddings.ts";
import {
  AnalysisLoader,
} from "./loaders.ts";
import {
  CandidateRepository,
} from "./candidates.ts";
import {
  FileWriter,
  SOURCE_INDEX_ANALYSIS_VERSION,
} from "./writer.ts";
import {
  IndexCounts,
} from "./counts.ts";
export {
  sourceContentHash,
} from "../encoding.ts";
export type {
  IndexedFile,
  IndexFileResult,
  IndexedSourceWindow,
  StoredSourceEmbedding,
  SourceWindowEmbeddingCandidate,
  SourceWindowEmbeddingCursor,
  SourceWindowEmbeddingCandidatePage,
  SourceWindowEmbeddingStateCandidate,
  SourceWindowEmbeddingStatePage,
  SourceWindowEmbeddingWrite,
  SemanticSourceChunk,
  SemanticWindowCandidate,
  SemanticCandidateDiagnostics,
  SemanticCandidateRead,
  NativeWindowCandidate,
  NativeCandidateRead,
  NativeLexicalMode,
  NativeCandidateOptions,
} from "../types.ts";

export {
  SOURCE_INDEX_ANALYSIS_VERSION,
};

export {
  SourceIndexSchemaMismatchError,
} from "./database.ts";

/** SQLite-backed persistence for analyzed chunks and retrieval windows. */
export class SourceIndex {
  private readonly lexicalIndex: LexicalIndex;
  private readonly files: FileRepository;
  private readonly fileReconciler: FileReconciler;
  private readonly embeddings: EmbeddingRepository;
  private readonly loader: AnalysisLoader;
  private readonly candidates: CandidateRepository;
  private readonly writer: FileWriter;
  private readonly counts: IndexCounts;

  constructor(
    readonly database: Database,
    private readonly readOnly = false,
  ) {
    initializeSourceIndexDatabase(database, readOnly);
    this.lexicalIndex = new LexicalIndex(database);
    this.files = new FileRepository(database);
    this.embeddings = new EmbeddingRepository(database);
    this.counts = new IndexCounts(database);
    this.loader = new AnalysisLoader(database, this.files, this.embeddings);
    this.candidates = new CandidateRepository(
      database,
      this.embeddings,
      this.counts,
    );
    this.writer = new FileWriter(database, this.files, this.lexicalIndex);
    this.fileReconciler = new FileReconciler(
      database,
      this.files,
      this.lexicalIndex,
    );
    if (!readOnly) this.lexicalIndex.synchronize();
  }

  static open(filename = ":memory:"): SourceIndex {
    return SourceIndex.create(filename, false);
  }

  static openReadOnly(filename: string): SourceIndex {
    return SourceIndex.create(filename, true);
  }

  private static create(filename: string, readOnly: boolean): SourceIndex {
    const database = createSourceIndexDatabase(filename, readOnly);
    try {
      return new SourceIndex(database, readOnly);
    } catch (error) {
      database.close();
      throw error;
    }
  }

  close(): void {
    this.database.close();
  }

  embeddingDimensions(): number | null {
    return this.embeddings.dimensions();
  }

  /** Ensure vec0 has the requested fixed dimension before embedding writes. */
  prepareEmbeddingSpace(identity: EmbeddingIdentity): void {
    this.embeddings.prepareSpace(identity);
  }

  /** Discard every vector before building a different global embedding space. */
  resetEmbeddingSpace(identity: EmbeddingIdentity): void {
    this.embeddings.resetSpace(identity);
  }

  getFile(path: string): IndexedFile | null {
    return this.files.get(path);
  }

  listFiles(): IndexedFile[] {
    return this.files.list();
  }

  /**
   * Make persisted files exactly match one successfully discovered project
   * view. FTS and vec0 are external projections, so remove those rows before
   * the relational file cascade.
   */
  reconcileFiles(paths: ReadonlySet<string>): string[] {
    return this.fileReconciler.reconcile(paths);
  }

  countChunks(): number {
    return this.counts.chunks();
  }

  countWindows(): number {
    return this.counts.windows();
  }

  countSemanticVectors(): number {
    return this.embeddings.countVectors();
  }

  hasSemanticVectors(): boolean {
    return this.embeddings.hasVectors();
  }

  /**
   * Read exact-space semantic candidates with their citation metadata.
   * Unavailable or corrupt embeddings are diagnosed and omitted rather than
   * aborting retrieval for the remaining valid rows.
   */
  readSemanticCandidates(
    identity: EmbeddingIdentity,
  ): SemanticCandidateRead {
    return this.candidates.readSemantic(identity);
  }

  /** Retrieve native semantic and FTS candidate lists for rank fusion. */
  readNativeCandidates(
    identity: EmbeddingIdentity,
    queryVector: Float32Array | null,
    query: string,
    limit: number,
    options: NativeCandidateOptions = {},
  ): NativeCandidateRead {
    return this.candidates.readNative(
      identity,
      queryVector,
      query,
      limit,
      options,
    );
  }

  /**
   * Find named chunks whose case-folded name belongs to exactly one persisted
   * file. Multiple same-file definitions (for example overloads) stay valid.
   */
  uniqueNamedSourceChunkIds(
    names: readonly string[],
  ): Set<number> {
    return this.candidates.uniqueNamedChunkIds(names);
  }

  countEmbeddingCandidates(
    identity: EmbeddingIdentity,
  ): number {
    return this.embeddings.countCandidates(identity);
  }

  /** Read one stable page of windows missing a vector in the initialized space. */
  readEmbeddingCandidatePage(
    identity: EmbeddingIdentity,
    limit: number,
    after: SourceWindowEmbeddingCursor | null = null,
  ): SourceWindowEmbeddingCandidatePage {
    return this.embeddings.readCandidatePage(identity, limit, after);
  }

  countEmbeddingInputMetadata(): number {
    return this.embeddings.countInputMetadata();
  }

  embeddingInputPolicy(): string | null {
    return this.embeddings.inputPolicy();
  }

  setEmbeddingInputPolicy(identity: string): void {
    this.embeddings.setInputPolicy(identity);
  }

  hasDirtyEmbeddingInputGroups(): boolean {
    return this.embeddings.hasDirtyInputGroups();
  }

  clearDirtyEmbeddingInputGroups(): void {
    this.embeddings.clearDirtyInputGroups();
  }

  /** Read every window with its persisted vector-input metadata. */
  readEmbeddingStatePage(
    identity: EmbeddingIdentity,
    limit: number,
    after: SourceWindowEmbeddingCursor | null = null,
  ): SourceWindowEmbeddingStatePage {
    return this.embeddings.readStatePage(identity, limit, after);
  }

  invalidateWindowEmbeddings(windowIds: readonly number[]): void {
    this.embeddings.invalidateWindows(windowIds);
  }

  /** Store one validated batch; stale window ids or hashes roll back the batch. */
  storeWindowEmbeddings(
    identity: EmbeddingIdentity,
    embeddings: readonly SourceWindowEmbeddingWrite[],
  ): void {
    this.embeddings.store(identity, embeddings);
  }

  /**
   * Index one source file. Unchanged normalized content is returned before the
   * parser runs; changed chunks and windows are replaced in one transaction.
   */
  async indexFile(
    path: string,
    source: string,
    options: SourceWindowOptions = {},
  ): Promise<IndexFileResult> {
    return this.writer.indexFile(path, source, options);
  }

  /** Load the meaningful chunk hierarchy used by relationship resolution. */
  loadChunks(path: string): SourceChunk[] {
    return this.loader.loadChunks(path);
  }

  /** Load the common import/export/call facts for one indexed file. */
  loadFacts(path: string): SourceFact[] {
    return this.loader.loadFacts(path);
  }

  loadAnalyzedFile(path: string): AnalyzedSourceFile | null {
    return this.loader.loadFile(path);
  }

  loadAnalyzedFiles(): AnalyzedSourceFile[] {
    return this.loader.loadFiles();
  }

  /** Load windows with file and parent metadata recovered through SQL joins. */
  loadWindows(path: string): IndexedSourceWindow[] {
    return this.loader.loadWindows(path);
  }
}
