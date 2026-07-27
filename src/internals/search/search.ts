

import type {
  Embedder,
} from "../embeddings/embedder.ts";
import {
  segmentSearchResults,
} from "./document-search.ts";
import {
  miniLmEmbedder,
} from "../embeddings/mini-lm.ts";
import {
  rankLexicalDocuments,
} from "./lexical-search.ts";
import {
  extractDefinitionIdentifiers,
  generatedPathMatcher,
} from "./signals.ts";
import {
  DEFAULT_SOURCE_WINDOW_PREVIEW_CHARACTERS,
  sourceTextPreview,
} from "../source/windows.ts";
import {
  type NativeWindowCandidate,
  type SemanticWindowCandidate,
  SourceIndex,
} from "../storage/source-index.ts";
import {
  MAX_SEARCH_RESULTS,
  SEARCH_RRF_K,
  SEARCH_SEMANTIC_WEIGHT,
  SEARCH_CANDIDATE_LIMIT,
  SEARCH_SEMANTIC_CANDIDATE_LIMIT,
  SEARCH_COMPLETE_MISSING_CANDIDATE_SCORES,
  SEARCH_CANDIDATE_AGGREGATION,
  SEARCH_FILE_CONFIRMATION_WEIGHT,
  SEARCH_EXACT_NAME_MULTIPLIER,
  SEARCH_UNIQUE_SYMBOL_MULTIPLIER,
  SEARCH_TEST_PATH_MULTIPLIER,
  SEARCH_GENERATED_PATH_MULTIPLIER,
} from "./config.ts";
import type {
  SearchRequest,
  SearchWindowRange,
  SearchSourceChunk,
  SearchHit,
  SearchResponse,
  SearchCandidateResponse,
  SearchOptions,
} from "./types.ts";
import {
  magnitude,
  cosine,
  compareText,
  applyExactNameSignal,
  applyMeasuredReranking,
  reciprocalRankScore,
  compareHits,
} from "./scoring.ts";
import {
  searchHit,
  groupedCandidateHits,
  collapseCandidateFiles,
} from "./candidates.ts";
export type {
  SearchRequest,
  SearchRange,
  SearchWindowRange,
  SearchSourceChunk,
  SearchHit,
  SearchDiagnostics,
  SearchResponse,
  SearchCandidateResponse,
  SearchOptions,
} from "./types.ts";
export {
  MAX_SEARCH_RESULTS,
  SEARCH_RRF_K,
  SEARCH_SEMANTIC_WEIGHT,
  SEARCH_CANDIDATE_LIMIT,
  SEARCH_SEMANTIC_CANDIDATE_LIMIT,
  SEARCH_COMPLETE_MISSING_CANDIDATE_SCORES,
  SEARCH_CANDIDATE_AGGREGATION,
  SEARCH_FILE_CONFIRMATION_WEIGHT,
  SEARCH_EXACT_NAME_MULTIPLIER,
  SEARCH_UNIQUE_SYMBOL_MULTIPLIER,
  SEARCH_TEST_PATH_MULTIPLIER,
  SEARCH_GENERATED_PATH_MULTIPLIER,
} from "./config.ts";

function validateRequest(request: SearchRequest): void {
  if (request.query.trim() === "") {
    throw new Error("search query must not be empty");
  }
  if (!Number.isSafeInteger(request.maxResults) || request.maxResults <= 0) {
    throw new RangeError("search maxResults must be a positive integer");
  }
  if (request.maxResults > MAX_SEARCH_RESULTS) {
    throw new RangeError(
      `search maxResults must not exceed ${MAX_SEARCH_RESULTS}`,
    );
  }
}

function validateEmbedder(embedder: Embedder): void {
  for (const field of ["model", "revision", "variant"] as const) {
    if (embedder[field].trim() === "") {
      throw new Error(`search embedder ${field} must not be empty`);
    }
  }
  if (!Number.isSafeInteger(embedder.dimensions) || embedder.dimensions <= 0) {
    throw new RangeError("search embedder dimensions must be a positive integer");
  }
}

function validateQueryVector(
  vectors: readonly Float32Array[],
  dimensions: number,
): Float32Array {
  if (vectors.length !== 1) {
    throw new Error(`search embedder returned ${vectors.length} query vectors; expected 1`);
  }
  const vector = vectors[0]!;
  if (!(vector instanceof Float32Array)) {
    throw new TypeError("search query vector is not a Float32Array");
  }
  if (vector.length !== dimensions) {
    throw new Error(
      `search query vector has ${vector.length} dimensions; expected ${dimensions}`,
    );
  }
  for (const value of vector) {
    if (!Number.isFinite(value)) {
      throw new Error("search query vector contains a non-finite value");
    }
  }
  const norm = magnitude(vector);
  if (!Number.isFinite(norm)) {
    throw new Error("search query vector magnitude is not finite");
  }
  if (norm === 0) {
    throw new Error("search query vector has zero magnitude");
  }
  return vector;
}

async function exactSearch(
  index: SourceIndex,
  request: SearchRequest,
  options: SearchOptions,
  embedder: Embedder,
  semanticWeight: number,
  previewCharacters: number,
  exactNameMultiplier: number,
  uniqueSymbolMultiplier: number,
  testPathMultiplier: number,
  isGeneratedPath: (path: string) => boolean,
  generatedPathMultiplier: number,
  fusionConvention: "current" | "v1",
): Promise<SearchCandidateResponse> {
  const read = index.readSemanticCandidates(embedder);
  if (read.candidates.length === 0) {
    return {
      results: [],
      diagnostics: {
        ...read.diagnostics,
        unscorableCandidates: 0,
        lexicalCandidates: 0,
      },
    };
  }
  const queryVector = validateQueryVector(
    await embedder.embed([request.query]),
    embedder.dimensions,
  );
  const uniqueSymbolChunkIds = semanticWeight < 1
    ? index.uniqueNamedSourceChunkIds(
        extractDefinitionIdentifiers(request.query),
      )
    : new Set<number>();
  let unscorableCandidates = 0;
  const scored: Array<{
    candidate: SemanticWindowCandidate;
    hit: SearchHit;
  }> = [];

  for (const candidate of read.candidates) {
    const score = cosine(queryVector, candidate.vector);
    if (score === null) {
      unscorableCandidates++;
      continue;
    }
    scored.push({
      candidate,
      hit: searchHit({ ...candidate, semanticScore: score }, previewCharacters),
    });
  }

  scored.sort((left, right) =>
    right.hit.semanticScore - left.hit.semanticScore ||
    compareText(left.hit.path, right.hit.path) ||
    left.hit.window.startOffset - right.hit.window.startOffset ||
    left.hit.windowId - right.hit.windowId
  );
  const semanticRanks = new Map(
    scored.map((candidate, index) => [candidate.hit.windowId, index + 1]),
  );
  const lexical = rankLexicalDocuments(
    request.query,
    scored.map(({ candidate }) => ({
      id: candidate.id,
      path: candidate.path,
      name: candidate.sourceChunk.name,
      text: candidate.text,
      startOffset: candidate.startOffset,
    })),
  );
  const lexicalRanks = new Map(
    lexical.map((candidate) => [candidate.id, candidate.rank]),
  );
  const lexicalScores = new Map(
    lexical.map((candidate) => [candidate.id, candidate.score]),
  );
  const candidates = scored.map(({ candidate, hit }) => ({
    id: candidate.id,
    path: candidate.path,
    text: candidate.text,
    startOffset: candidate.startOffset,
    endOffset: candidate.endOffset,
    startLine: candidate.startLine,
    endLine: candidate.endLine,
    sourceChunk: candidate.sourceChunk,
    semanticScore: hit.semanticScore,
    lexicalScore: lexicalScores.get(candidate.id) ?? 0,
  }));
  const applySignals = (hit: SearchHit): void => {
    applyExactNameSignal(
      hit,
      request.query,
      semanticWeight,
      exactNameMultiplier,
    );
    applyMeasuredReranking(
      hit,
      uniqueSymbolChunkIds,
      uniqueSymbolMultiplier,
      testPathMultiplier,
      isGeneratedPath,
      generatedPathMultiplier,
    );
  };
  const aggregation = options.candidateAggregation ??
    SEARCH_CANDIDATE_AGGREGATION;
  let results = groupedCandidateHits(
    candidates,
    semanticRanks,
    lexicalRanks,
    aggregation === "chunk-file",
    semanticWeight,
    fusionConvention,
    previewCharacters,
    applySignals,
  );
  if (aggregation === "chunk-file") {
    results = collapseCandidateFiles(
      results,
      options.fileConfirmationWeight ?? SEARCH_FILE_CONFIRMATION_WEIGHT,
    );
  }
  results.sort(compareHits);
  return {
    results: results.slice(0, request.maxResults),
    diagnostics: {
      ...read.diagnostics,
      unscorableCandidates,
      lexicalCandidates: lexical.length,
    },
  };
}

async function nativeSearch(
  index: SourceIndex,
  request: SearchRequest,
  options: SearchOptions,
  embedder: Embedder,
  semanticWeight: number,
  previewCharacters: number,
  candidateLimit: number,
  semanticCandidateLimit: number,
  exactNameMultiplier: number,
  uniqueSymbolMultiplier: number,
  testPathMultiplier: number,
  isGeneratedPath: (path: string) => boolean,
  generatedPathMultiplier: number,
  fusionConvention: "current" | "v1",
): Promise<SearchCandidateResponse> {
  const queryVector = index.hasSemanticVectors()
    ? validateQueryVector(
        await embedder.embed([request.query]),
        embedder.dimensions,
      )
    : null;
  const read = index.readNativeCandidates(
    embedder,
    queryVector,
    request.query,
    candidateLimit,
    {
      lexicalMode: options.lexicalMode,
      semanticLimit: semanticCandidateLimit,
      completeMissingScores: options.completeMissingCandidateScores ??
        SEARCH_COMPLETE_MISSING_CANDIDATE_SCORES,
      completeMissingSemanticScores: options.completeMissingSemanticScores,
      completeMissingLexicalScores: options.completeMissingLexicalScores,
    },
  );
  const semanticRanks = new Map(
    read.semantic.map((candidate, index) => [candidate.id, index + 1]),
  );
  const lexicalRanks = new Map(
    read.lexical.map((candidate, index) => [candidate.id, index + 1]),
  );
  const baselineSemanticRanks = new Map(
    read.baselineSemantic.map((candidate, index) => [candidate.id, index + 1]),
  );
  const baselineLexicalRanks = new Map(
    read.baselineLexical.map((candidate, index) => [candidate.id, index + 1]),
  );
  const uniqueSymbolChunkIds = semanticWeight < 1
    ? index.uniqueNamedSourceChunkIds(
        extractDefinitionIdentifiers(request.query),
      )
    : new Set<number>();
  const candidates = new Map<number, NativeWindowCandidate>();
  for (const candidate of read.semantic) candidates.set(candidate.id, candidate);
  for (const candidate of read.lexical) {
    const semantic = candidates.get(candidate.id);
    candidates.set(candidate.id, semantic
      ? { ...semantic, lexicalScore: candidate.lexicalScore }
      : candidate);
  }
  const baselineCandidates = new Map<number, NativeWindowCandidate>();
  for (const candidate of read.baselineSemantic) {
    baselineCandidates.set(candidate.id, candidate);
  }
  for (const candidate of read.baselineLexical) {
    const semantic = baselineCandidates.get(candidate.id);
    baselineCandidates.set(candidate.id, semantic
      ? { ...semantic, lexicalScore: candidate.lexicalScore }
      : candidate);
  }
  const applySignals = (hit: SearchHit): void => {
    applyExactNameSignal(
      hit,
      request.query,
      semanticWeight,
      exactNameMultiplier,
    );
    applyMeasuredReranking(
      hit,
      uniqueSymbolChunkIds,
      uniqueSymbolMultiplier,
      testPathMultiplier,
      isGeneratedPath,
      generatedPathMultiplier,
    );
  };
  const aggregation = options.candidateAggregation ??
    SEARCH_CANDIDATE_AGGREGATION;
  let results = groupedCandidateHits(
    candidates.values(),
    semanticRanks,
    lexicalRanks,
    aggregation !== "window",
    semanticWeight,
    fusionConvention,
    previewCharacters,
    applySignals,
  );
  if (aggregation === "chunk-file") {
    results = collapseCandidateFiles(
      results,
      options.fileConfirmationWeight ?? SEARCH_FILE_CONFIRMATION_WEIGHT,
    );
  } else if (aggregation === "anchored-file") {
    const confirmationWeight = options.fileConfirmationWeight ?? 0.25;
    const bonusCap = options.fileBonusCap ?? 0.1;
    const baselineResults = [...baselineCandidates.values()].map((candidate) => {
      const hit = searchHit(candidate, previewCharacters);
      hit.score = reciprocalRankScore(
        baselineSemanticRanks.get(candidate.id),
        baselineLexicalRanks.get(candidate.id),
        semanticWeight,
        fusionConvention,
      );
      applySignals(hit);
      return hit;
    });
    const baselineByFile = new Map<string, SearchHit[]>();
    for (const hit of baselineResults) {
      const file = baselineByFile.get(hit.path);
      if (file === undefined) baselineByFile.set(hit.path, [hit]);
      else file.push(hit);
    }
    const confirmationByFile = new Map<string, SearchHit[]>();
    for (const hit of results) {
      const file = confirmationByFile.get(hit.path);
      if (file === undefined) confirmationByFile.set(hit.path, [hit]);
      else file.push(hit);
    }
    results = [...baselineByFile.entries()].map(([path, baselineHits]) => {
      baselineHits.sort(compareHits);
      const best = baselineHits[0]!;
      const confirmations = confirmationByFile.get(path) ?? [];
      confirmations.sort(compareHits);
      const strongest = confirmations[0];
      const second = confirmations[1];
      let rawBonus = strongest === undefined
        ? 0
        : Math.max(0, strongest.score - best.score);
      if (strongest !== undefined && second !== undefined) {
        rawBonus += confirmationWeight * Math.min(
          strongest.score,
          second.score,
        );
      }
      best.score += Math.min(rawBonus, best.score * bonusCap);
      return best;
    });
  }
  results.sort(compareHits);
  results = results.slice(0, request.maxResults);

  return {
    results,
    diagnostics: {
      ...read.diagnostics,
      unscorableCandidates: read.unscorableCandidates,
      lexicalCandidates: read.lexicalCandidates,
    },
  };
}

/** Unsegmented hybrid candidates used by correctness tests and benchmarks. */
export async function searchCandidates(
  index: SourceIndex,
  request: SearchRequest,
  options: SearchOptions = {},
): Promise<SearchCandidateResponse> {
  validateRequest(request);
  if (options.previewCharacters !== undefined) {
    sourceTextPreview("", options.previewCharacters);
  }
  const semanticWeight = options.semanticWeight ?? SEARCH_SEMANTIC_WEIGHT;
  if (
    !Number.isFinite(semanticWeight) || semanticWeight < 0 ||
    semanticWeight > 1
  ) {
    throw new RangeError("search semanticWeight must be between 0 and 1");
  }
  const embedder = options.embedder ?? miniLmEmbedder;
  validateEmbedder(embedder);
  const exactNameMultiplier = options.exactNameMultiplier ??
    SEARCH_EXACT_NAME_MULTIPLIER;
  if (!Number.isFinite(exactNameMultiplier) || exactNameMultiplier <= 0) {
    throw new RangeError("search exactNameMultiplier must be positive");
  }
  const uniqueSymbolMultiplier = options.uniqueSymbolMultiplier ??
    SEARCH_UNIQUE_SYMBOL_MULTIPLIER;
  if (!Number.isFinite(uniqueSymbolMultiplier) || uniqueSymbolMultiplier <= 0) {
    throw new RangeError("search uniqueSymbolMultiplier must be positive");
  }
  const testPathMultiplier = options.testPathMultiplier ??
    SEARCH_TEST_PATH_MULTIPLIER;
  if (!Number.isFinite(testPathMultiplier) || testPathMultiplier <= 0) {
    throw new RangeError("search testPathMultiplier must be positive");
  }
  const generatedPathMultiplier = options.generatedPathMultiplier ??
    SEARCH_GENERATED_PATH_MULTIPLIER;
  if (
    !Number.isFinite(generatedPathMultiplier) ||
    generatedPathMultiplier <= 0
  ) {
    throw new RangeError("search generatedPathMultiplier must be positive");
  }
  const isGeneratedPath = generatedPathMatcher(options.generatedPatterns ?? []);
  const fusionConvention = options.fusionConvention ?? "current";
  const candidateLimit = options.candidateLimit ?? SEARCH_CANDIDATE_LIMIT;
  if (!Number.isSafeInteger(candidateLimit) || candidateLimit <= 0) {
    throw new RangeError("search candidateLimit must be a positive integer");
  }
  const semanticCandidateLimit = options.semanticCandidateLimit ??
    SEARCH_SEMANTIC_CANDIDATE_LIMIT;
  if (
    !Number.isSafeInteger(semanticCandidateLimit) ||
    semanticCandidateLimit <= 0
  ) {
    throw new RangeError(
      "search semanticCandidateLimit must be a positive integer",
    );
  }
  const candidateAggregation = options.candidateAggregation ??
    SEARCH_CANDIDATE_AGGREGATION;
  if (
    candidateAggregation !== "window" &&
    candidateAggregation !== "chunk-file" &&
    candidateAggregation !== "anchored-file"
  ) {
    throw new RangeError(
      "search candidateAggregation must be window, chunk-file, or anchored-file",
    );
  }
  if (
    options.engine === "exact" &&
    candidateAggregation === "anchored-file"
  ) {
    throw new RangeError(
      "exact search does not support anchored-file candidate aggregation",
    );
  }
  const fileConfirmationWeight = options.fileConfirmationWeight ??
    SEARCH_FILE_CONFIRMATION_WEIGHT;
  if (
    !Number.isFinite(fileConfirmationWeight) ||
    fileConfirmationWeight < 0 || fileConfirmationWeight > 1
  ) {
    throw new RangeError(
      "search fileConfirmationWeight must be between 0 and 1",
    );
  }
  const fileBonusCap = options.fileBonusCap ?? 0.1;
  if (!Number.isFinite(fileBonusCap) || fileBonusCap < 0 || fileBonusCap > 1) {
    throw new RangeError("search fileBonusCap must be between 0 and 1");
  }
  const previewCharacters = options.previewCharacters ??
    DEFAULT_SOURCE_WINDOW_PREVIEW_CHARACTERS;
  return options.engine === "exact"
    ? exactSearch(
        index,
        request,
        options,
        embedder,
        semanticWeight,
        previewCharacters,
        exactNameMultiplier,
        uniqueSymbolMultiplier,
        testPathMultiplier,
        isGeneratedPath,
        generatedPathMultiplier,
        fusionConvention,
      )
    : nativeSearch(
        index,
        request,
        options,
        embedder,
        semanticWeight,
        previewCharacters,
        candidateLimit,
        semanticCandidateLimit,
        exactNameMultiplier,
        uniqueSymbolMultiplier,
        testPathMultiplier,
        isGeneratedPath,
        generatedPathMultiplier,
        fusionConvention,
      );
}

/** Hybrid project search with independent source and documentation segments. */
export async function search(
  index: SourceIndex,
  request: SearchRequest,
  options: SearchOptions = {},
): Promise<SearchResponse> {
  validateRequest(request);
  const previewCharacters = options.previewCharacters ??
    DEFAULT_SOURCE_WINDOW_PREVIEW_CHARACTERS;
  const projectPaths = new Set(
    index.listFiles().map((file) => file.path),
  );
  const candidates = await searchCandidates(index, {
    query: request.query,
    maxResults: MAX_SEARCH_RESULTS,
  }, options);
  return {
    ...segmentSearchResults(
      index,
      candidates.results,
      projectPaths,
      request.maxResults,
      previewCharacters,
    ),
    diagnostics: candidates.diagnostics,
  };
}
