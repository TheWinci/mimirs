import { mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  Embedder,
  EmbeddingIdentity,
} from "../embeddings/embedder.ts";
import { miniLmEmbedder } from "../embeddings/mini-lm.ts";
import {
  createDefaultIndexConfigIfMissing,
  isIndexDomainEnabled,
  loadIndexConfig,
  type IndexConfig,
} from "../indexing/config.ts";
import {
  ensureProjectState,
  projectLayout,
} from "../project/layout.ts";
import {
  ProjectDirectoryNotFoundError,
  projectRelationshipOptions,
} from "../project/analysis.ts";
import {
  search as searchIndex,
  type SearchRequest,
  type SearchResponse,
} from "./search.ts";
import {
  searchPerspectiveCandidates,
  type PerspectiveSearchResponse,
} from "./perspective-search.ts";
import {
  fusePerspectiveCandidates,
  inactivePerspectiveFusion,
  type PerspectiveFusionDiagnostics,
  type PerspectiveFusionPolicy,
} from "./perspective-fusion.ts";
import { MAX_SEARCH_RESULTS } from "./config.ts";
import { DEFAULT_SOURCE_WINDOW_PREVIEW_CHARACTERS } from
  "../source/windows.ts";
import {
  embedSourceWindows,
  miniLmPathAverageEmbedder,
  type EmbedSourceWindowsProgress,
  type EmbedSourceWindowsSummary,
} from "../storage/source-embeddings.ts";
import {
  indexProject,
  type ProjectIndexProgress,
  type ProjectIndexSummary,
} from "../storage/project-index.ts";
import { SourceIndex } from "../storage/source-index.ts";
import {
  embedFactDocuments,
  factDocumentEmbedder,
  type EmbedFactDocumentsProgress,
  type EmbedFactDocumentsSummary,
} from "../storage/fact-embeddings.ts";
import {
  embedRelationDocuments,
  relationDocumentEmbedder,
  type EmbedRelationDocumentsProgress,
  type EmbedRelationDocumentsSummary,
} from "../storage/relation-embeddings.ts";
import { connectSourceFiles } from "../source/relationships.ts";

export interface ProjectSearchSessionOptions {
  batchSize?: number;
  config?: IndexConfig;
  databasePath?: string;
  embedder?: Embedder;
  /** Shared raw query geometry for fact and relationship documents. */
  perspectiveEmbedder?: Embedder;
  /** Null/omitted observes pools without changing production ordering. */
  perspectiveFusion?: PerspectiveFusionPolicy | null;
  /** Completed identity manifest read once before this session attaches. */
  embeddingManifest?: EmbeddingIdentity | null;
  previewCharacters?: number;
  targetCharacters?: number;
  readOnly?: boolean;
  signal?: AbortSignal;
  onEmbeddingProgress?: (
    progress: EmbedSourceWindowsProgress,
  ) => void | Promise<void>;
  onIndexProgress?: (
    progress: ProjectIndexProgress,
  ) => void | Promise<void>;
  onFactEmbeddingProgress?: (
    progress: EmbedFactDocumentsProgress,
  ) => void | Promise<void>;
  onRelationEmbeddingProgress?: (
    progress: EmbedRelationDocumentsProgress,
  ) => void | Promise<void>;
  dependencies?: {
    embedSourceWindows?: typeof embedSourceWindows;
    embedFactDocuments?: typeof embedFactDocuments;
    embedRelationDocuments?: typeof embedRelationDocuments;
    indexProject?: typeof indexProject;
  };
}

export type ProjectSearchIndexSummary = Omit<ProjectIndexSummary, "currentPaths">;

export interface ProjectSearchPreparation {
  index: ProjectSearchIndexSummary;
  embeddings: EmbedSourceWindowsSummary;
  facts: EmbedFactDocumentsSummary;
  relations: EmbedRelationDocumentsSummary;
}

export interface ProjectSearchResponse extends SearchResponse {
  preparation: ProjectSearchPreparation;
  perspectives: PerspectiveSearchResponse;
  perspectiveFusion: PerspectiveFusionDiagnostics;
}

export class ProjectSearchNotReadyError extends Error {
  constructor() {
    super("project index is still preparing; call status and retry shortly");
    this.name = "ProjectSearchNotReadyError";
  }
}

function withoutCurrentPaths(
  summary: ProjectIndexSummary,
): ProjectSearchIndexSummary {
  const { currentPaths: _currentPaths, ...publicSummary } = summary;
  return publicSummary;
}

async function assertProjectDirectory(
  directory: string,
  root: string,
): Promise<void> {
  try {
    if (!(await stat(root)).isDirectory()) {
      throw new ProjectDirectoryNotFoundError(directory);
    }
  } catch (error) {
    if (error instanceof ProjectDirectoryNotFoundError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ProjectDirectoryNotFoundError(directory);
    }
    throw error;
  }
}

interface PreparedProjectSearch {
  preparation: ProjectSearchPreparation;
  config: IndexConfig;
}

/** Explicitly refreshed session for one project's indexing and search paths. */
export class ProjectSearchSession {
  readonly root: string;
  readonly databasePath: string;
  readonly sourceIndex: SourceIndex;

  private readonly indexingIndex: SourceIndex;
  private readonly options: ProjectSearchSessionOptions;
  private refreshQueue: Promise<void> = Promise.resolve();
  private searchQueue: Promise<void> = Promise.resolve();
  private prepared: PreparedProjectSearch | null = null;
  private embeddingManifest: EmbeddingIdentity | null | undefined;
  private state: "open" | "closing" | "closed" = "open";
  private closePromise: Promise<void> | null = null;

  private constructor(
    root: string,
    databasePath: string,
    sourceIndex: SourceIndex,
    indexingIndex: SourceIndex,
    options: ProjectSearchSessionOptions,
  ) {
    this.root = root;
    this.databasePath = databasePath;
    this.sourceIndex = sourceIndex;
    this.indexingIndex = indexingIndex;
    this.options = options;
    this.embeddingManifest = options.embeddingManifest;
  }

  static async open(
    directory: string,
    options: ProjectSearchSessionOptions = {},
  ): Promise<ProjectSearchSession> {
    const layout = projectLayout(directory);
    const root = layout.root;
    const usesManagedState = options.databasePath === undefined;
    await assertProjectDirectory(directory, root);
    if (!options.readOnly && options.config && usesManagedState) {
      await ensureProjectState(layout);
    }
    if (!options.config && !options.readOnly) {
      await createDefaultIndexConfigIfMissing(root);
    }
    if (!options.config) {
      await loadIndexConfig(root);
    }

    const databasePath = options.databasePath ??
      layout.databasePath;
    if (databasePath !== ":memory:" && !options.readOnly) {
      await mkdir(dirname(databasePath), { recursive: true });
    }
    const indexingIndex = options.readOnly
      ? SourceIndex.openReadOnly(databasePath)
      : SourceIndex.open(databasePath);
    const sourceIndex = databasePath === ":memory:" || options.readOnly
      ? indexingIndex
      : SourceIndex.openReadOnly(databasePath);
    let sessionOptions = options;
    if (
      options.embeddingManifest &&
      sourceIndex.embeddingDimensions() !== options.embeddingManifest.dimensions
    ) {
      if (options.readOnly) {
        sourceIndex.close();
        throw new Error(
          "published embedding dimensions do not match the SQLite vector space",
        );
      }
      sessionOptions = { ...options, embeddingManifest: null };
    }
    return new ProjectSearchSession(
      root,
      databasePath,
      sourceIndex,
      indexingIndex,
      sessionOptions,
    );
  }

  search(request: SearchRequest): Promise<ProjectSearchResponse> {
    return this.enqueueSearch(async () => {
      const prepared = this.prepared;
      if (!prepared) throw new ProjectSearchNotReadyError();
      const embedder = this.options.embedder ?? miniLmPathAverageEmbedder;
      const response = await searchIndex(this.sourceIndex, {
        ...request,
        maxResults: MAX_SEARCH_RESULTS,
      }, {
        embedder,
        previewCharacters: this.options.previewCharacters,
        generatedPatterns: prepared.config.generated,
      });
      const perspectiveEmbedder = this.options.perspectiveEmbedder ??
        (this.options.embedder ? this.options.embedder : miniLmEmbedder);
      const perspectives = await searchPerspectiveCandidates(
        this.sourceIndex,
        request,
        { embedder: perspectiveEmbedder, candidateLimit: 150 },
      );
      const fusion = this.options.perspectiveFusion
        ? fusePerspectiveCandidates(
          this.sourceIndex,
          response.source,
          perspectives,
          this.options.perspectiveFusion,
          this.options.previewCharacters ??
            DEFAULT_SOURCE_WINDOW_PREVIEW_CHARACTERS,
        )
        : { results: response.source, diagnostics: inactivePerspectiveFusion() };
      const source = fusion.results.slice(0, request.maxResults);
      const returnedPaths = new Set(source.map((hit) => hit.path));
      return {
        ...response,
        source,
        relations: response.relations.filter((relation) =>
          returnedPaths.has(relation.sourcePath)
        ),
        preparation: prepared.preparation,
        perspectives,
        perspectiveFusion: fusion.diagnostics,
      };
    });
  }

  refresh(config?: IndexConfig): Promise<ProjectSearchPreparation> {
    if (this.options.readOnly) {
      return Promise.reject(new Error("read-only project search session cannot refresh"));
    }
    return this.enqueueRefresh(async () => {
      const prepared = await this.refreshInternal(config);
      this.prepared = prepared;
      return prepared.preparation;
    });
  }

  /** Attach a one-shot read-only CLI to a current Mimirs-owned database. */
  attachOwnedIndex(restoredConfig?: IndexConfig): Promise<void> {
    return this.enqueueRefresh(async () => {
      if (!this.options.readOnly) {
        throw new Error("owned index attachment requires a read-only session");
      }
      const config = restoredConfig ?? this.options.config ??
        await loadIndexConfig(this.root);
      const embedder = this.options.embedder ?? miniLmPathAverageEmbedder;
      const dimensions = this.sourceIndex.embeddingDimensions();
      if (dimensions !== null && dimensions !== embedder.dimensions) {
        throw new Error(
          "indexed embedding dimensions are incompatible; run `mimirs index`",
        );
      }
      const files = this.sourceIndex.listFiles().length;
      const windows = this.sourceIndex.countWindows();
      const embedded = this.sourceIndex.countSemanticVectors();
      const perspectiveEmbedder = this.options.perspectiveEmbedder ??
        (this.options.embedder ? this.options.embedder : miniLmEmbedder);
      const factEmbedder = factDocumentEmbedder(perspectiveEmbedder);
      const relationEmbedder = relationDocumentEmbedder(perspectiveEmbedder);
      this.embeddingManifest = embedder;
      this.prepared = {
        config,
        preparation: {
          index: {
            root: this.root,
            discovered: files,
            indexed: 0,
            unchanged: files,
            failed: [],
          },
          embeddings: {
            model: embedder.model,
            revision: embedder.revision,
            variant: embedder.variant,
            dimensions: embedder.dimensions,
            total: windows,
            embedded: 0,
            unchanged: embedded,
            batches: 0,
          },
          facts: {
            model: factEmbedder.model,
            revision: factEmbedder.revision,
            variant: factEmbedder.variant,
            dimensions: factEmbedder.dimensions,
            total: this.sourceIndex.countFactDocuments(),
            embedded: 0,
            unchanged: this.sourceIndex.countFactVectors(),
            batches: 0,
            projectedFiles: files,
            changedProjectionFiles: 0,
          },
          relations: {
            model: relationEmbedder.model,
            revision: relationEmbedder.revision,
            variant: relationEmbedder.variant,
            dimensions: relationEmbedder.dimensions,
            total: this.sourceIndex.countRelationDocuments(),
            embedded: 0,
            unchanged: this.sourceIndex.countRelationVectors(),
            batches: 0,
            projectedFiles: files,
            changedProjectionFiles: 0,
          },
        },
      };
    });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.state === "closed") return Promise.resolve();
    this.state = "closing";
    this.closePromise = Promise.all([this.refreshQueue, this.searchQueue]).then(() => {
      this.sourceIndex.close();
      if (this.indexingIndex !== this.sourceIndex) this.indexingIndex.close();
      this.state = "closed";
    });
    return this.closePromise;
  }

  private enqueueSearch<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state !== "open") {
      return Promise.reject(new Error("project search session is closed"));
    }
    const result = this.searchQueue.then(operation);
    this.searchQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private enqueueRefresh<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state !== "open") {
      return Promise.reject(new Error("project search session is closed"));
    }
    const result = this.refreshQueue.then(operation);
    this.refreshQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async refreshInternal(
    configOverride?: IndexConfig,
  ): Promise<PreparedProjectSearch> {
    this.options.signal?.throwIfAborted();
    const runIndexProject = this.options.dependencies?.indexProject ??
      indexProject;
    const runEmbedSourceWindows =
      this.options.dependencies?.embedSourceWindows ?? embedSourceWindows;
    const runEmbedFactDocuments =
      this.options.dependencies?.embedFactDocuments ?? embedFactDocuments;
    const runEmbedRelationDocuments =
      this.options.dependencies?.embedRelationDocuments ?? embedRelationDocuments;
    const config = configOverride ?? this.options.config ??
      await loadIndexConfig(this.root);
    this.options.signal?.throwIfAborted();
    const sourceConfig = isIndexDomainEnabled(config, "source")
      ? config
      : { ...config, include: [] };
    const indexSummary = await runIndexProject(this.root, this.indexingIndex, {
      config: sourceConfig,
      targetCharacters: this.options.targetCharacters,
      onProgress: this.options.onIndexProgress,
      signal: this.options.signal,
    });
    const embedder = this.options.embedder ?? miniLmPathAverageEmbedder;
    const embeddings = await runEmbedSourceWindows(
      this.indexingIndex,
      embedder,
      {
        batchSize: this.options.batchSize,
        previousIdentity: this.embeddingManifest,
        onProgress: this.options.onEmbeddingProgress,
        signal: this.options.signal,
      },
    );
    const perspectiveEmbedder = this.options.perspectiveEmbedder ??
      (this.options.embedder ? this.options.embedder : miniLmEmbedder);
    const facts = await runEmbedFactDocuments(
      this.indexingIndex,
      factDocumentEmbedder(perspectiveEmbedder),
      {
        batchSize: this.options.batchSize,
        onProgress: this.options.onFactEmbeddingProgress,
        signal: this.options.signal,
      },
    );
    const analyzedFiles = this.indexingIndex.loadAnalyzedFiles();
    const relationships = connectSourceFiles(
      analyzedFiles,
      await projectRelationshipOptions(
        this.root,
        new Set(indexSummary.currentPaths),
      ),
    );
    const relations = await runEmbedRelationDocuments(
      this.indexingIndex,
      relationships,
      relationDocumentEmbedder(perspectiveEmbedder),
      {
        batchSize: this.options.batchSize,
        onProgress: this.options.onRelationEmbeddingProgress,
        signal: this.options.signal,
      },
    );
    this.options.signal?.throwIfAborted();
    this.embeddingManifest = embeddings;
    return {
      config,
      preparation: {
        index: withoutCurrentPaths(indexSummary),
        embeddings,
        facts,
        relations,
      },
    };
  }
}
