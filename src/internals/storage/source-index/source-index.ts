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
  SourceRelationshipResult,
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
  FactEmbeddingCursor,
  FactEmbeddingCandidatePage,
  FactEmbeddingWrite,
  FactCandidateRead,
  RelationEmbeddingCursor,
  RelationEmbeddingCandidatePage,
  RelationEmbeddingWrite,
  RelationCandidateRead,
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
import {
  FactRepository,
  type FactDocumentSyncSummary,
} from "./facts.ts";
import {
  RelationRepository,
  type RelationDocumentSyncSummary,
} from "./relations.ts";
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
  IndexedFactDocument,
  FactEmbeddingCursor,
  FactEmbeddingCandidate,
  FactEmbeddingCandidatePage,
  FactEmbeddingWrite,
  SemanticFactCandidate,
  FactCandidateDiagnostics,
  FactCandidateRead,
  IndexedRelationDocument,
  RelationEmbeddingCursor,
  RelationEmbeddingCandidate,
  RelationEmbeddingCandidatePage,
  RelationEmbeddingWrite,
  SemanticRelationCandidate,
  RelationCandidateDiagnostics,
  RelationCandidateRead,
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
  private readonly facts: FactRepository;
  private readonly relations: RelationRepository;

  constructor(
    readonly database: Database,
    private readonly readOnly = false,
  ) {
    initializeSourceIndexDatabase(database, readOnly);
    this.lexicalIndex = new LexicalIndex(database);
    this.files = new FileRepository(database);
    this.embeddings = new EmbeddingRepository(database);
    this.counts = new IndexCounts(database);
    this.facts = new FactRepository(database);
    this.relations = new RelationRepository(database);
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

  /** Rebuild deterministic fact documents from persisted raw analysis. */
  synchronizeFactDocuments(): FactDocumentSyncSummary {
    if (this.readOnly) {
      throw new Error("read-only source index cannot synchronize fact documents");
    }
    return this.facts.synchronize(this.loader.loadFiles());
  }

  countFactDocuments(): number {
    return this.facts.countDocuments();
  }

  countFactVectors(): number {
    return this.facts.countVectors();
  }

  prepareFactEmbeddingSpace(identity: EmbeddingIdentity): void {
    this.facts.prepareSpace(identity);
  }

  countFactEmbeddingCandidates(identity: EmbeddingIdentity): number {
    return this.facts.countCandidates(identity);
  }

  readFactEmbeddingCandidatePage(
    identity: EmbeddingIdentity,
    limit: number,
    after: FactEmbeddingCursor | null = null,
  ): FactEmbeddingCandidatePage {
    return this.facts.readCandidatePage(identity, limit, after);
  }

  storeFactEmbeddings(
    identity: EmbeddingIdentity,
    embeddings: readonly FactEmbeddingWrite[],
  ): void {
    this.facts.store(identity, embeddings);
  }

  /** Retrieve the independent semantic fact-document candidate pool. */
  readFactCandidates(
    identity: EmbeddingIdentity,
    queryVector: Float32Array,
    limit: number,
  ): FactCandidateRead {
    return this.facts.readCandidates(identity, queryVector, limit);
  }

  /** Rebuild deterministic relation documents from the resolved project graph. */
  synchronizeRelationDocuments(
    relationships: SourceRelationshipResult,
  ): RelationDocumentSyncSummary {
    if (this.readOnly) {
      throw new Error("read-only source index cannot synchronize relation documents");
    }
    return this.relations.synchronize(this.loader.loadFiles(), relationships);
  }

  countRelationDocuments(): number {
    return this.relations.countDocuments();
  }

  countRelationVectors(): number {
    return this.relations.countVectors();
  }

  prepareRelationEmbeddingSpace(identity: EmbeddingIdentity): void {
    this.relations.prepareSpace(identity);
  }

  countRelationEmbeddingCandidates(identity: EmbeddingIdentity): number {
    return this.relations.countCandidates(identity);
  }

  readRelationEmbeddingCandidatePage(
    identity: EmbeddingIdentity,
    limit: number,
    after: RelationEmbeddingCursor | null = null,
  ): RelationEmbeddingCandidatePage {
    return this.relations.readCandidatePage(identity, limit, after);
  }

  storeRelationEmbeddings(
    identity: EmbeddingIdentity,
    embeddings: readonly RelationEmbeddingWrite[],
  ): void {
    this.relations.store(identity, embeddings);
  }

  /** Retrieve the independent semantic relationship-document candidate pool. */
  readRelationCandidates(
    identity: EmbeddingIdentity,
    queryVector: Float32Array,
    limit: number,
  ): RelationCandidateRead {
    return this.relations.readCandidates(identity, queryVector, limit);
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
