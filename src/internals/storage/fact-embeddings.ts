import type {
  Embedder,
  EmbeddingIdentity,
  EmbedOptions,
} from "../embeddings/embedder.ts";
import { miniLmEmbedder } from "../embeddings/mini-lm.ts";
import type {
  FactEmbeddingCandidate,
  SourceIndex,
} from "./source-index.ts";

export const DEFAULT_FACT_EMBEDDING_BATCH_SIZE = 1_024;

/** Retain an embedder's query geometry while isolating the fact document space. */
export function factDocumentEmbedder(embedder: Embedder): Embedder {
  return Object.freeze({
    ...embedder,
    variant: `${embedder.variant}|document:fact-scope:v1`,
    embed: (texts: readonly string[], options?: EmbedOptions) =>
      embedder.embed(texts, options),
  });
}

/** Fact documents share MiniLM geometry but retain an independent identity. */
export const miniLmFactEmbedder = factDocumentEmbedder(miniLmEmbedder);

export interface EmbedFactDocumentsOptions {
  batchSize?: number;
  onProgress?: (progress: EmbedFactDocumentsProgress) => void | Promise<void>;
  signal?: AbortSignal;
}

export interface EmbedFactDocumentsProgress {
  completed: number;
  total: number;
}

export interface EmbedFactDocumentsSummary extends EmbeddingIdentity {
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
      throw new Error(`fact embedder ${field} must not be empty`);
    }
  }
  if (!Number.isSafeInteger(embedder.dimensions) || embedder.dimensions <= 0) {
    throw new RangeError("fact embedder dimensions must be positive");
  }
}

function validateVectors(
  candidates: readonly FactEmbeddingCandidate[],
  vectors: readonly Float32Array[],
  dimensions: number,
): void {
  if (vectors.length !== candidates.length) {
    throw new Error(
      `fact embedder returned ${vectors.length} vectors for ` +
        `${candidates.length} documents`,
    );
  }
  for (let index = 0; index < vectors.length; index++) {
    const vector = vectors[index]!;
    if (!(vector instanceof Float32Array)) {
      throw new TypeError(`fact embedder vector ${index} is not a Float32Array`);
    }
    if (vector.length !== dimensions) {
      throw new Error(
        `fact embedder vector ${index} has ${vector.length} dimensions; ` +
          `expected ${dimensions}`,
      );
    }
    if (vector.some((component) => !Number.isFinite(component))) {
      throw new Error(`fact embedder vector ${index} is non-finite`);
    }
  }
}

/** Materialize and incrementally embed the independent fact-document pool. */
export async function embedFactDocuments(
  index: SourceIndex,
  embedder: Embedder = miniLmFactEmbedder,
  options: EmbedFactDocumentsOptions = {},
): Promise<EmbedFactDocumentsSummary> {
  options.signal?.throwIfAborted();
  validateEmbedder(embedder);
  const batchSize = options.batchSize ?? DEFAULT_FACT_EMBEDDING_BATCH_SIZE;
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new RangeError("fact embedding batchSize must be positive");
  }
  const projection = index.synchronizeFactDocuments();
  index.prepareFactEmbeddingSpace(embedder);
  const total = index.countFactDocuments();
  const missing = index.countFactEmbeddingCandidates(embedder);
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
    const page = index.readFactEmbeddingCandidatePage(embedder, batchSize, cursor);
    if (page.candidates.length === 0 || page.nextCursor === null) {
      throw new Error(
        `fact embedding candidates changed: expected ${missing}, embedded ${embedded}`,
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
    index.storeFactEmbeddings(
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
