import type { Embedder } from "../embeddings/embedder.ts";
import { miniLmEmbedder } from "../embeddings/mini-lm.ts";
import {
  factDocumentEmbedder,
} from "../storage/fact-embeddings.ts";
import {
  relationDocumentEmbedder,
} from "../storage/relation-embeddings.ts";
import type { SourceIndex } from "../storage/source-index.ts";
import {
  searchFactCandidates,
  type FactSearchResponse,
} from "./fact-search.ts";
import {
  searchRelationCandidates,
  type RelationSearchResponse,
} from "./relation-search.ts";
import type { SearchRequest } from "./types.ts";

export interface PerspectiveSearchResponse {
  facts: FactSearchResponse;
  relations: RelationSearchResponse;
}

export interface PerspectiveSearchOptions {
  /** Base query geometry; document-space identities are derived automatically. */
  embedder?: Embedder;
  candidateLimit?: number;
  evidencePerFile?: number;
}

/** Retrieve both independent evidence pools with a single query inference. */
export async function searchPerspectiveCandidates(
  index: SourceIndex,
  request: SearchRequest,
  options: PerspectiveSearchOptions = {},
): Promise<PerspectiveSearchResponse> {
  const base = options.embedder ?? miniLmEmbedder;
  const factEmbedder = factDocumentEmbedder(base);
  const relationEmbedder = relationDocumentEmbedder(base);
  const empty = index.countFactDocuments() === 0 &&
    index.countRelationDocuments() === 0;
  const vectors = empty
    ? [new Float32Array(base.dimensions)]
    : await base.embed([request.query]);
  const queryVector = vectors[0];
  if (!queryVector || vectors.length !== 1) {
    throw new Error("perspective query embedder must return exactly one vector");
  }
  const shared = {
    queryVector,
    candidateLimit: options.candidateLimit,
    evidencePerFile: options.evidencePerFile,
  };
  const facts = await searchFactCandidates(index, request, {
    ...shared,
    embedder: factEmbedder,
  });
  const relations = await searchRelationCandidates(index, request, {
    ...shared,
    embedder: relationEmbedder,
  });
  return { facts, relations };
}
