import type {
  Embedder,
  EmbeddingIdentity,
  EmbedOptions,
} from "../embeddings/embedder.ts";
import { miniLmEmbedder } from "../embeddings/mini-lm.ts";
import type { SourceRelationshipResult } from
  "../source/relationships.ts";
import type {
  RelationEmbeddingCandidate,
  SourceIndex,
} from "./source-index.ts";

export const DEFAULT_RELATION_EMBEDDING_BATCH_SIZE = 1_024;

/** Retain an embedder's query geometry while isolating the relation document space. */
export function relationDocumentEmbedder(embedder: Embedder): Embedder {
  return Object.freeze({
    ...embedder,
    variant: `${embedder.variant}|document:relation-edge:v1`,
    embed: (texts: readonly string[], options?: EmbedOptions) =>
      embedder.embed(texts, options),
  });
}

export const miniLmRelationEmbedder = relationDocumentEmbedder(miniLmEmbedder);

export interface EmbedRelationDocumentsOptions {
  batchSize?: number;
  onProgress?: (progress: EmbedRelationDocumentsProgress) => void | Promise<void>;
  signal?: AbortSignal;
}

export interface EmbedRelationDocumentsProgress {
  completed: number;
  total: number;
}

export interface EmbedRelationDocumentsSummary extends EmbeddingIdentity {
  total: number;
  embedded: number;
  unchanged: number;
  batches: number;
  projectedFiles: number;
  changedProjectionFiles: number;
}

function validateEmbedder(embedder: Embedder): void {
  for (const field of ["model", "revision", "variant"] as const) {
    if (embedder[field].trim() === "") {
      throw new Error(`relation embedder ${field} must not be empty`);
    }
  }
  if (!Number.isSafeInteger(embedder.dimensions) || embedder.dimensions <= 0) {
    throw new RangeError("relation embedder dimensions must be positive");
  }
}

function validateVectors(
  candidates: readonly RelationEmbeddingCandidate[],
  vectors: readonly Float32Array[],
  dimensions: number,
): void {
  if (vectors.length !== candidates.length) {
    throw new Error(
      `relation embedder returned ${vectors.length} vectors for ` +
        `${candidates.length} documents`,
    );
  }
  for (let index = 0; index < vectors.length; index++) {
    const vector = vectors[index]!;
    if (!(vector instanceof Float32Array)) {
      throw new TypeError(
        `relation embedder vector ${index} is not a Float32Array`,
      );
    }
    if (vector.length !== dimensions) {
      throw new Error(
        `relation embedder vector ${index} has ${vector.length} dimensions; ` +
          `expected ${dimensions}`,
      );
    }
    if (vector.some((component) => !Number.isFinite(component))) {
      throw new Error(`relation embedder vector ${index} is non-finite`);
    }
  }
}

/** Materialize and incrementally embed the independent relationship pool. */
export async function embedRelationDocuments(
  index: SourceIndex,
  relationships: SourceRelationshipResult,
  embedder: Embedder = miniLmRelationEmbedder,
  options: EmbedRelationDocumentsOptions = {},
): Promise<EmbedRelationDocumentsSummary> {
  options.signal?.throwIfAborted();
  validateEmbedder(embedder);
  const batchSize = options.batchSize ?? DEFAULT_RELATION_EMBEDDING_BATCH_SIZE;
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new RangeError("relation embedding batchSize must be positive");
  }
  const projection = index.synchronizeRelationDocuments(relationships);
  index.prepareRelationEmbeddingSpace(embedder);
  const total = index.countRelationDocuments();
  const missing = index.countRelationEmbeddingCandidates(embedder);
  let embedded = 0;
  let batches = 0;
  let cursor = null;
  let lastReported = -1;
  const progress = async (completed: number) => {
    const value = Math.max(lastReported, Math.min(total, completed));
    if (value === lastReported) return;
    lastReported = value;
    await options.onProgress?.({ completed: value, total });
  };
  await progress(total - missing);
  while (embedded < missing) {
    options.signal?.throwIfAborted();
    const page = index.readRelationEmbeddingCandidatePage(
      embedder,
      batchSize,
      cursor,
    );
    if (page.candidates.length === 0 || page.nextCursor === null) {
      throw new Error(
        `relation embedding candidates changed: expected ${missing}, ` +
          `embedded ${embedded}`,
      );
    }
    const vectors = await embedder.embed(
      page.candidates.map((candidate) => candidate.text),
      {
        onProgress: async (value) => {
          const withinBatch = value.total === 0
            ? page.candidates.length
            : Math.floor(
              (value.completed / value.total) * page.candidates.length,
            );
          await progress(total - missing + embedded + withinBatch);
        },
      },
    );
    options.signal?.throwIfAborted();
    validateVectors(page.candidates, vectors, embedder.dimensions);
    index.storeRelationEmbeddings(
      embedder,
      page.candidates.map((candidate, candidateIndex) => ({
        documentId: candidate.id,
        textHash: candidate.textHash,
        vector: vectors[candidateIndex]!,
      })),
    );
    embedded += page.candidates.length;
    batches++;
    cursor = page.nextCursor;
    await progress(total - missing + embedded);
  }
  return {
    model: embedder.model,
    revision: embedder.revision,
    variant: embedder.variant,
    dimensions: embedder.dimensions,
    total,
    embedded,
    unchanged: total - missing,
    batches,
    projectedFiles: projection.files,
    changedProjectionFiles: projection.changedFiles,
  };
}
