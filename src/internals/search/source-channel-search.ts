import type { Embedder } from "../embeddings/embedder.ts";
import {
  miniLmPathAverageEmbedder,
} from "../storage/source-embeddings.ts";
import type {
  NativeWindowCandidate,
  SourceIndex,
} from "../storage/source-index.ts";
import {
  SEARCH_CANDIDATE_LIMIT,
  SEARCH_SEMANTIC_CANDIDATE_LIMIT,
} from "./config.ts";
import type { SearchRequest } from "./types.ts";

export type SourceChannel = "semantic" | "lexical";

export interface SourceChannelEvidence {
  windowId: number;
  sourceChunkId: number;
  startOffset: number;
  endOffset: number;
  score: number;
}

export interface SourceChannelHit {
  path: string;
  score: number;
  channel: SourceChannel;
  evidence: SourceChannelEvidence;
}

export interface SourceChannelSearchResponse {
  semantic: SourceChannelHit[];
  lexical: SourceChannelHit[];
  diagnostics: {
    semanticWindows: number;
    lexicalWindows: number;
    totalWindows: number;
    embeddedWindows: number;
    missingEmbeddings: number;
  };
}

export interface SourceChannelSearchOptions {
  embedder?: Embedder;
  queryVector?: Float32Array;
  lexicalCandidateLimit?: number;
  semanticCandidateLimit?: number;
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

function validateVector(vector: Float32Array, dimensions: number): void {
  if (
    !(vector instanceof Float32Array) || vector.length !== dimensions ||
    vector.some((component) => !Number.isFinite(component))
  ) {
    throw new Error("source-channel query embedder returned an invalid vector");
  }
}

function collapseFiles(
  candidates: readonly NativeWindowCandidate[],
  channel: SourceChannel,
  limit: number,
): SourceChannelHit[] {
  const seen = new Set<string>();
  const results: SourceChannelHit[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.path)) continue;
    seen.add(candidate.path);
    const score = channel === "semantic"
      ? candidate.semanticScore
      : candidate.lexicalScore;
    results.push({
      path: candidate.path,
      score,
      channel,
      evidence: {
        windowId: candidate.id,
        sourceChunkId: candidate.sourceChunk.id,
        startOffset: candidate.startOffset,
        endOffset: candidate.endOffset,
        score,
      },
    });
    if (results.length === limit) break;
  }
  return results;
}

/** Retrieve the two production candidate channels before score completion or fusion. */
export async function searchSourceChannels(
  index: SourceIndex,
  request: SearchRequest,
  options: SourceChannelSearchOptions = {},
): Promise<SourceChannelSearchResponse> {
  if (request.query.trim() === "") {
    throw new Error("source-channel search query must not be empty");
  }
  positiveInteger(request.maxResults, "source-channel search maxResults");
  const lexicalCandidateLimit = options.lexicalCandidateLimit ??
    SEARCH_CANDIDATE_LIMIT;
  const semanticCandidateLimit = options.semanticCandidateLimit ??
    SEARCH_SEMANTIC_CANDIDATE_LIMIT;
  positiveInteger(lexicalCandidateLimit, "lexicalCandidateLimit");
  positiveInteger(semanticCandidateLimit, "semanticCandidateLimit");
  const embedder = options.embedder ?? miniLmPathAverageEmbedder;
  let queryVector = options.queryVector ?? null;
  if (queryVector === null && index.hasSemanticVectors()) {
    const vectors = await embedder.embed([request.query]);
    if (vectors.length !== 1 || !vectors[0]) {
      throw new Error("source-channel query embedder must return one vector");
    }
    queryVector = vectors[0];
  }
  if (queryVector !== null) validateVector(queryVector, embedder.dimensions);
  const read = index.readNativeCandidates(
    embedder,
    queryVector,
    request.query,
    lexicalCandidateLimit,
    {
      semanticLimit: semanticCandidateLimit,
      completeMissingScores: false,
    },
  );
  return {
    semantic: collapseFiles(
      read.baselineSemantic,
      "semantic",
      request.maxResults,
    ),
    lexical: collapseFiles(
      read.baselineLexical,
      "lexical",
      request.maxResults,
    ),
    diagnostics: {
      semanticWindows: read.baselineSemantic.length,
      lexicalWindows: read.baselineLexical.length,
      totalWindows: read.diagnostics.total,
      embeddedWindows: read.diagnostics.compatible,
      missingEmbeddings: read.diagnostics.missingEmbedding,
    },
  };
}
