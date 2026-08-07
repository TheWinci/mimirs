import type { Embedder } from "../embeddings/embedder.ts";
import {
  miniLmFactEmbedder,
} from "../storage/fact-embeddings.ts";
import type {
  FactCandidateDiagnostics,
  SourceIndex,
} from "../storage/source-index.ts";
import type { SearchRequest } from "./types.ts";

const DEFAULT_EVIDENCE_PER_FILE = 3;

export interface FactSearchEvidence {
  documentId: number;
  ownerChunkId: number | null;
  startOffset: number;
  text: string;
  score: number;
}

export interface FactSearchHit {
  path: string;
  score: number;
  evidence: FactSearchEvidence[];
}

export interface FactSearchResponse {
  results: FactSearchHit[];
  diagnostics: FactCandidateDiagnostics & {
    retrievedDocuments: number;
  };
}

export interface FactSearchOptions {
  embedder?: Embedder;
  /** Reuse one validated query vector across independent perspective pools. */
  queryVector?: Float32Array;
  /** Document candidates read before collapsing to unique files. */
  candidateLimit?: number;
  evidencePerFile?: number;
}

/** Search the fact vector space independently and retain exact provenance. */
export async function searchFactCandidates(
  index: SourceIndex,
  request: SearchRequest,
  options: FactSearchOptions = {},
): Promise<FactSearchResponse> {
  if (request.query.trim() === "") {
    throw new Error("fact search query must not be empty");
  }
  if (!Number.isSafeInteger(request.maxResults) || request.maxResults <= 0) {
    throw new RangeError("fact search maxResults must be positive");
  }
  const candidateLimit = options.candidateLimit ?? request.maxResults * 4;
  if (!Number.isSafeInteger(candidateLimit) || candidateLimit <= 0) {
    throw new RangeError("fact search candidateLimit must be positive");
  }
  const evidencePerFile = options.evidencePerFile ?? DEFAULT_EVIDENCE_PER_FILE;
  if (!Number.isSafeInteger(evidencePerFile) || evidencePerFile <= 0) {
    throw new RangeError("fact search evidencePerFile must be positive");
  }
  const embedder = options.embedder ?? miniLmFactEmbedder;
  const vectors = options.queryVector
    ? [options.queryVector]
    : await embedder.embed([request.query]);
  const vector = vectors[0];
  if (!vector || vectors.length !== 1) {
    throw new Error("fact query embedder must return exactly one vector");
  }
  if (
    !(vector instanceof Float32Array) ||
    vector.length !== embedder.dimensions ||
    vector.some((component) => !Number.isFinite(component))
  ) {
    throw new Error("fact query embedder returned an invalid vector");
  }
  const read = index.readFactCandidates(embedder, vector, candidateLimit);
  const byPath = new Map<string, FactSearchHit>();
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
