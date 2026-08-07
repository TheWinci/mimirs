import type { Embedder } from "../embeddings/embedder.ts";
import { miniLmRelationEmbedder } from
  "../storage/relation-embeddings.ts";
import type {
  RelationCandidateDiagnostics,
  SourceIndex,
} from "../storage/source-index.ts";
import type { SearchRequest } from "./types.ts";

const DEFAULT_EVIDENCE_PER_FILE = 3;

export interface RelationSearchEvidence {
  documentId: number;
  ownerChunkId: number | null;
  startOffset: number;
  direction: "incoming" | "outgoing";
  relationKind: "import" | "re-export" | "call";
  text: string;
  score: number;
}

export interface RelationSearchHit {
  path: string;
  score: number;
  evidence: RelationSearchEvidence[];
}

export interface RelationSearchResponse {
  results: RelationSearchHit[];
  diagnostics: RelationCandidateDiagnostics & {
    retrievedDocuments: number;
  };
}

export interface RelationSearchOptions {
  embedder?: Embedder;
  queryVector?: Float32Array;
  candidateLimit?: number;
  evidencePerFile?: number;
}

/** Search the typed relationship vector space and retain exact edge provenance. */
export async function searchRelationCandidates(
  index: SourceIndex,
  request: SearchRequest,
  options: RelationSearchOptions = {},
): Promise<RelationSearchResponse> {
  if (request.query.trim() === "") {
    throw new Error("relation search query must not be empty");
  }
  if (!Number.isSafeInteger(request.maxResults) || request.maxResults <= 0) {
    throw new RangeError("relation search maxResults must be positive");
  }
  const candidateLimit = options.candidateLimit ?? request.maxResults * 4;
  if (!Number.isSafeInteger(candidateLimit) || candidateLimit <= 0) {
    throw new RangeError("relation search candidateLimit must be positive");
  }
  const evidencePerFile = options.evidencePerFile ?? DEFAULT_EVIDENCE_PER_FILE;
  if (!Number.isSafeInteger(evidencePerFile) || evidencePerFile <= 0) {
    throw new RangeError("relation search evidencePerFile must be positive");
  }
  const embedder = options.embedder ?? miniLmRelationEmbedder;
  const vectors = options.queryVector
    ? [options.queryVector]
    : await embedder.embed([request.query]);
  const vector = vectors[0];
  if (!vector || vectors.length !== 1) {
    throw new Error("relation query embedder must return exactly one vector");
  }
  if (
    !(vector instanceof Float32Array) ||
    vector.length !== embedder.dimensions ||
    vector.some((component) => !Number.isFinite(component))
  ) {
    throw new Error("relation query embedder returned an invalid vector");
  }
  const read = index.readRelationCandidates(embedder, vector, candidateLimit);
  const byPath = new Map<string, RelationSearchHit>();
  for (const candidate of read.candidates) {
    let hit = byPath.get(candidate.path);
    if (!hit) {
      hit = { path: candidate.path, score: candidate.score, evidence: [] };
      byPath.set(candidate.path, hit);
    }
    if (hit.evidence.length < evidencePerFile) {
      hit.evidence.push({
        documentId: candidate.id,
        ownerChunkId: candidate.ownerChunkId,
        startOffset: candidate.startOffset,
        direction: candidate.direction,
        relationKind: candidate.relationKind,
        text: candidate.text,
        score: candidate.score,
      });
    }
  }
  return {
    results: [...byPath.values()].slice(0, request.maxResults),
    diagnostics: {
      ...read.diagnostics,
      retrievedDocuments: read.candidates.length,
    },
  };
}
