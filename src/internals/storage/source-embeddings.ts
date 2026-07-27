import { createHash } from "node:crypto";

import {
  sameEmbeddingIdentity,
  type Embedder,
  type EmbeddingIdentity,
} from "../embeddings/embedder.ts";
import {
  embedPathAveragedWithMiniLm,
  miniLmEmbedder,
} from "../embeddings/mini-lm.ts";
import type {
  SourceIndex,
  SourceWindowEmbeddingCandidate,
} from "./source-index.ts";

export const DEFAULT_EMBEDDING_BATCH_SIZE = 1_024;
export const DEFAULT_EMBEDDING_CANDIDATE_PAGE_BATCHES = 16;

export interface EmbedSourceWindowsOptions {
  batchSize?: number;
  /** Internal memory bound; must preserve whole inference batches. */
  candidatePageSize?: number;
  /**
   * Known prior identity. Omit when opening a current Mimirs-owned schema;
   * provide a differing identity only to request an explicit space reset.
   */
  previousIdentity?: EmbeddingIdentity | null;
  onProgress?: (progress: EmbedSourceWindowsProgress) => void | Promise<void>;
  signal?: AbortSignal;
}

export interface EmbedSourceWindowsProgress {
  completed: number;
  total: number;
}

export interface SourceEmbeddingProjection {
  /** Versioned identity; change it whenever projected text can change. */
  id: string;
  project(candidate: Readonly<SourceWindowEmbeddingCandidate>): string;
}

export interface SourceDocumentEmbedder extends Embedder {
  documentProjection?: SourceEmbeddingProjection;
  duplicatePathDisambiguation?: SourceDuplicatePathDisambiguation;
  /** Document-only inference; query embedding continues to call `embed`. */
  embedProjectedInputs?: (
    texts: readonly string[],
  ) => Promise<readonly Float32Array[]>;
}

export interface SourceDuplicatePathDisambiguation {
  /** Versioned identity; change it whenever the conditional prefix changes. */
  id: string;
  project(
    candidate: Readonly<SourceWindowEmbeddingCandidate>,
    baseInput: string,
  ): string;
}

export const SOURCE_NAME_PROJECTION: SourceEmbeddingProjection = {
  id: "source-name:v1",
  project(candidate): string {
    const name = candidate.sourceChunkName?.trim();
    return name ? `${name}\n${candidate.text}` : candidate.text;
  },
};

export const LABELED_SOURCE_NAME_PROJECTION: SourceEmbeddingProjection = {
  id: "labeled-source-name:v1",
  project(candidate): string {
    const name = candidate.sourceChunkName?.trim();
    return name ? `Symbol: ${name}\n${candidate.text}` : candidate.text;
  },
};

export const SOURCE_PATH_PROJECTION: SourceEmbeddingProjection = {
  id: "source-path:v1",
  project(candidate): string {
    return `File: ${candidate.path}\n${candidate.text}`;
  },
};

export const DUPLICATE_PATH_DISAMBIGUATION: SourceDuplicatePathDisambiguation = {
  id: "duplicate-path:v1",
  project(candidate, baseInput): string {
    return `File: ${candidate.path}\n${baseInput}`;
  },
};

/** Keep query inference raw while giving projected documents a distinct space. */
export function withSourceEmbeddingProjection(
  embedder: SourceDocumentEmbedder,
  projection: SourceEmbeddingProjection,
): SourceDocumentEmbedder {
  const id = projection.id.trim();
  if (id === "" || /[\r\n]/.test(id)) {
    throw new Error("source embedding projection id must be one non-empty line");
  }
  return {
    model: embedder.model,
    revision: embedder.revision,
    variant: `${embedder.variant}|document:${id}`,
    dimensions: embedder.dimensions,
    embed: (texts) => embedder.embed(texts),
    documentProjection: projection,
    duplicatePathDisambiguation: embedder.duplicatePathDisambiguation,
    embedProjectedInputs: embedder.embedProjectedInputs,
  };
}

const pathProjectedMiniLm = withSourceEmbeddingProjection(
  miniLmEmbedder,
  SOURCE_PATH_PROJECTION,
);

/** Production MiniLM: raw queries, independent path-prefixed document average. */
export const miniLmPathAverageEmbedder: SourceDocumentEmbedder = Object.freeze({
  ...pathProjectedMiniLm,
  variant: `${pathProjectedMiniLm.variant}|` +
    "document-embedding:independent-subvector-average:v1",
  embedProjectedInputs: embedPathAveragedWithMiniLm,
});

/** Keep unique documents raw while path-labeling cross-path exact duplicates. */
export function withDuplicatePathDisambiguation(
  embedder: SourceDocumentEmbedder,
  disambiguation: SourceDuplicatePathDisambiguation =
    DUPLICATE_PATH_DISAMBIGUATION,
): SourceDocumentEmbedder {
  const id = disambiguation.id.trim();
  if (id === "" || /[\r\n]/.test(id)) {
    throw new Error(
      "duplicate path disambiguation id must be one non-empty line",
    );
  }
  return {
    model: embedder.model,
    revision: embedder.revision,
    variant: `${embedder.variant}|document:${id}`,
    dimensions: embedder.dimensions,
    embed: (texts) => embedder.embed(texts),
    documentProjection: embedder.documentProjection,
    duplicatePathDisambiguation: disambiguation,
    embedProjectedInputs: embedder.embedProjectedInputs,
  };
}

export interface EmbedSourceWindowsSummary extends EmbeddingIdentity {
  total: number;
  embedded: number;
  unchanged: number;
  batches: number;
}

function validateEmbedder(embedder: Embedder): void {
  for (const field of ["model", "revision", "variant"] as const) {
    if (embedder[field].trim() === "") {
      throw new Error(`embedder ${field} must not be empty`);
    }
  }
  if (!Number.isSafeInteger(embedder.dimensions) || embedder.dimensions <= 0) {
    throw new RangeError("embedder dimensions must be a positive integer");
  }
}

function validateVectors(
  candidates: readonly SourceWindowEmbeddingCandidate[],
  vectors: readonly Float32Array[],
  dimensions: number,
): void {
  if (vectors.length !== candidates.length) {
    throw new Error(
      `embedder returned ${vectors.length} vectors for ${candidates.length} texts`,
    );
  }
  for (let index = 0; index < vectors.length; index++) {
    const vector = vectors[index]!;
    if (!(vector instanceof Float32Array)) {
      throw new TypeError(`embedder vector ${index} is not a Float32Array`);
    }
    if (vector.length !== dimensions) {
      throw new Error(
        `embedder vector ${index} has ${vector.length} dimensions; ` +
          `expected ${dimensions}`,
      );
    }
    for (const value of vector) {
      if (!Number.isFinite(value)) {
        throw new Error(`embedder vector ${index} contains a non-finite value`);
      }
    }
  }
}

function projectedInputHash(input: string): string {
  return createHash("sha256").update(input).digest("base64");
}

function embeddingInputPolicy(embedder: SourceDocumentEmbedder): string {
  return JSON.stringify([
    embedder.model,
    embedder.revision,
    embedder.variant,
    embedder.dimensions,
  ]);
}

interface DuplicatePathGroup {
  firstPath: string;
  spansPaths: boolean;
}

interface ProjectedInput {
  baseInput: string;
  baseHash: string;
  effectiveInput: string;
  effectiveHash: string;
  pathDisambiguated: boolean;
}

function baseProjectedInput(
  embedder: SourceDocumentEmbedder,
  candidate: SourceWindowEmbeddingCandidate,
): string {
  return embedder.documentProjection?.project(candidate) ?? candidate.text;
}

function projectedInput(
  embedder: SourceDocumentEmbedder,
  candidate: SourceWindowEmbeddingCandidate,
  duplicatePathGroups: ReadonlyMap<string, DuplicatePathGroup> | null,
): ProjectedInput {
  const baseInput = baseProjectedInput(embedder, candidate);
  const baseHash = projectedInputHash(baseInput);
  const pathDisambiguated =
    embedder.duplicatePathDisambiguation !== undefined &&
    duplicatePathGroups?.get(baseHash)?.spansPaths === true;
  const effectiveInput = pathDisambiguated
    ? embedder.duplicatePathDisambiguation!.project(candidate, baseInput)
    : baseInput;
  return {
    baseInput,
    baseHash,
    effectiveInput,
    effectiveHash: projectedInputHash(effectiveInput),
    pathDisambiguated,
  };
}

/** Initialize one global vector space and embed every missing source window. */
export async function embedSourceWindows(
  index: SourceIndex,
  embedder: SourceDocumentEmbedder = miniLmPathAverageEmbedder,
  options: EmbedSourceWindowsOptions = {},
): Promise<EmbedSourceWindowsSummary> {
  options.signal?.throwIfAborted();
  validateEmbedder(embedder);
  const batchSize = options.batchSize ?? DEFAULT_EMBEDDING_BATCH_SIZE;
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new RangeError("batchSize must be a positive integer");
  }
  const candidatePageSize = options.candidatePageSize ??
    batchSize * DEFAULT_EMBEDDING_CANDIDATE_PAGE_BATCHES;
  if (
    !Number.isSafeInteger(candidatePageSize) || candidatePageSize <= 0 ||
    candidatePageSize % batchSize !== 0
  ) {
    throw new RangeError(
      "candidatePageSize must be a positive multiple of batchSize",
    );
  }

  if (
    options.previousIdentity === undefined ||
    sameEmbeddingIdentity(options.previousIdentity, embedder)
  ) {
    index.prepareEmbeddingSpace(embedder);
  } else {
    index.resetEmbeddingSpace(embedder);
  }
  const total = index.countWindows();
  let duplicatePathGroups: Map<string, DuplicatePathGroup> | null = null;
  const storedBeforeReconciliation = index.countSemanticVectors();
  const inputPolicy = embeddingInputPolicy(embedder);
  const previousInputPolicy = index.embeddingInputPolicy();
  const inputPolicyChanged = storedBeforeReconciliation > 0 &&
    previousInputPolicy !== null && previousInputPolicy !== inputPolicy;
  const needsEmbeddingInputReconciliation = inputPolicyChanged ||
    (
      embedder.duplicatePathDisambiguation !== undefined &&
      (
        storedBeforeReconciliation !== total ||
        index.countEmbeddingInputMetadata() !== total ||
        index.hasDirtyEmbeddingInputGroups()
      )
    );
  if (needsEmbeddingInputReconciliation) {
    let scanned = 0;
    let stateCursor = null;
    if (embedder.duplicatePathDisambiguation !== undefined) {
      duplicatePathGroups = new Map<string, DuplicatePathGroup>();
      while (scanned < total) {
        options.signal?.throwIfAborted();
        const page = index.readEmbeddingStatePage(
          embedder,
          candidatePageSize,
          stateCursor,
        );
        if (page.candidates.length === 0 || page.nextCursor === null) {
          throw new Error(
            `embedding state changed during duplicate grouping: expected ${total}, ` +
              `scanned ${scanned}`,
          );
        }
        for (const candidate of page.candidates) {
          const baseHash = projectedInputHash(
            baseProjectedInput(embedder, candidate),
          );
          const group = duplicatePathGroups.get(baseHash);
          if (group === undefined) {
            duplicatePathGroups.set(baseHash, {
              firstPath: candidate.path,
              spansPaths: false,
            });
          } else if (group.firstPath !== candidate.path) {
            group.spansPaths = true;
          }
        }
        scanned += page.candidates.length;
        stateCursor = page.nextCursor;
      }
    }

    scanned = 0;
    stateCursor = null;
    while (scanned < total) {
      options.signal?.throwIfAborted();
      const page = index.readEmbeddingStatePage(
        embedder,
        candidatePageSize,
        stateCursor,
      );
      if (page.candidates.length === 0 || page.nextCursor === null) {
        throw new Error(
          `embedding state changed during input reconciliation: expected ${total}, ` +
            `scanned ${scanned}`,
        );
      }
      const invalid = page.candidates.flatMap((candidate) => {
        const desired = projectedInput(
          embedder,
          candidate,
          duplicatePathGroups,
        );
        return candidate.hasVector &&
            candidate.baseInputHash === desired.baseHash &&
            candidate.effectiveInputHash === desired.effectiveHash &&
            candidate.pathDisambiguated === desired.pathDisambiguated
          ? []
          : [candidate.id];
      });
      index.invalidateWindowEmbeddings(invalid);
      scanned += page.candidates.length;
      stateCursor = page.nextCursor;
    }
    index.clearDirtyEmbeddingInputGroups();
  } else if (embedder.duplicatePathDisambiguation === undefined) {
    index.clearDirtyEmbeddingInputGroups();
  }
  // A complete primary-keyed vec0 table needs no missing-vector join.
  const stored = index.countSemanticVectors();
  const missing = stored === total
    ? 0
    : index.countEmbeddingCandidates(embedder);
  let embedded = 0;
  let batches = 0;
  let cursor = null;
  await options.onProgress?.({ completed: total - missing, total });
  const lastDuplicateOrdinalByProjectedInputHash = new Map<string, number>();
  let counted = 0;
  let countCursor = null;
  {
    const firstSeenProjectedInputHashes = new Set<string>();
    while (counted < missing) {
      options.signal?.throwIfAborted();
      const page = index.readEmbeddingCandidatePage(
        embedder,
        candidatePageSize,
        countCursor,
      );
      if (page.candidates.length === 0 || page.nextCursor === null) {
        throw new Error(
          `embedding candidates changed during deduplication: expected ${missing}, ` +
            `counted ${counted}`,
        );
      }
      for (const candidate of page.candidates) {
        const hash = projectedInput(
          embedder,
          candidate,
          duplicatePathGroups,
        ).effectiveHash;
        if (firstSeenProjectedInputHashes.has(hash)) {
          lastDuplicateOrdinalByProjectedInputHash.set(hash, counted);
        } else {
          firstSeenProjectedInputHashes.add(hash);
        }
        counted++;
      }
      countCursor = page.nextCursor;
    }
  }
  if (missing > 0) Bun.gc(true);
  const vectorsByProjectedInputHash = new Map<string, Float32Array>();
  let candidateOrdinal = 0;
  while (embedded < missing) {
    options.signal?.throwIfAborted();
    const page = index.readEmbeddingCandidatePage(
      embedder,
      candidatePageSize,
      cursor,
    );
    if (page.candidates.length === 0 || page.nextCursor === null) {
      throw new Error(
        `embedding candidates changed during iteration: expected ${missing}, ` +
          `embedded ${embedded}`,
      );
    }
    for (let start = 0; start < page.candidates.length; start += batchSize) {
      options.signal?.throwIfAborted();
      const batch = page.candidates.slice(start, start + batchSize);
      const inputs = batch.map((candidate) =>
        projectedInput(embedder, candidate, duplicatePathGroups)
      );
      const hashes: string[] = [];
      const pendingHashes: string[] = [];
      const pendingInputs: string[] = [];
      const pendingCandidates: SourceWindowEmbeddingCandidate[] = [];
      const pending = new Set<string>();
      for (let index = 0; index < batch.length; index++) {
        const candidate = batch[index]!;
        const input = inputs[index]!;
        const hash = input.effectiveHash;
        hashes.push(hash);
        if (!vectorsByProjectedInputHash.has(hash) && !pending.has(hash)) {
          pending.add(hash);
          pendingHashes.push(hash);
          pendingInputs.push(input.effectiveInput);
          pendingCandidates.push(candidate);
        }
      }
      if (pendingInputs.length > 0) {
        const inferred = await (
          embedder.embedProjectedInputs?.(pendingInputs) ??
          embedder.embed(pendingInputs)
        );
        options.signal?.throwIfAborted();
        validateVectors(pendingCandidates, inferred, embedder.dimensions);
        for (let index = 0; index < pendingHashes.length; index++) {
          vectorsByProjectedInputHash.set(
            pendingHashes[index]!,
            inferred[index]!,
          );
        }
      }
      const vectors = hashes.map((hash) =>
        vectorsByProjectedInputHash.get(hash)!
      );
      validateVectors(batch, vectors, embedder.dimensions);
      index.storeWindowEmbeddings(
        embedder,
        batch.map((candidate, candidateIndex) => ({
          windowId: candidate.id,
          textHash: candidate.textHash,
          vector: vectors[candidateIndex]!,
          baseInputHash: inputs[candidateIndex]!.baseHash,
          effectiveInputHash: inputs[candidateIndex]!.effectiveHash,
          pathDisambiguated: inputs[candidateIndex]!.pathDisambiguated,
        })),
      );
      for (const hash of hashes) {
        const lastDuplicateOrdinal =
          lastDuplicateOrdinalByProjectedInputHash.get(hash);
        if (
          lastDuplicateOrdinal === undefined ||
          lastDuplicateOrdinal === candidateOrdinal
        ) {
          lastDuplicateOrdinalByProjectedInputHash.delete(hash);
          vectorsByProjectedInputHash.delete(hash);
        }
        candidateOrdinal++;
      }
      embedded += batch.length;
      batches++;
      await options.onProgress?.({
        completed: total - missing + embedded,
        total,
      });
      options.signal?.throwIfAborted();
    }
    cursor = page.nextCursor;
  }

  index.setEmbeddingInputPolicy(inputPolicy);

  return {
    model: embedder.model,
    revision: embedder.revision,
    variant: embedder.variant,
    dimensions: embedder.dimensions,
    total,
    embedded,
    unchanged: total - missing,
    batches,
  };
}
