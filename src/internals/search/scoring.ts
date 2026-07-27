import {
  lexicalTerms,
} from "./lexical-search.ts";
import {
  isTestSourcePath,
} from "./signals.ts";
import {
  SEARCH_RRF_K,
} from "./config.ts";
import type {
  SearchHit,
} from "./types.ts";

export function magnitude(vector: Float32Array): number {
  let squared = 0;
  for (const value of vector) squared += value * value;
  return Math.sqrt(squared);
}
export function cosine(
  query: Float32Array,
  candidate: Float32Array,
): number | null {
  const candidateNorm = magnitude(candidate);
  if (!Number.isFinite(candidateNorm) || candidateNorm === 0) return null;
  const queryNorm = magnitude(query);
  let dot = 0;
  for (let index = 0; index < query.length; index++) {
    dot += query[index]! * candidate[index]!;
  }
  const score = dot / (queryNorm * candidateNorm);
  return Number.isFinite(score) ? score : null;
}
export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
function exactNameMatch(query: string, name: string | null): boolean {
  const nameTerms = lexicalTerms(name ?? "");
  if (nameTerms.length === 0) return false;
  const queryTerms = lexicalTerms(query);
  return nameTerms.every((term) => queryTerms.includes(term));
}
export function applyExactNameSignal(
  hit: SearchHit,
  query: string,
  semanticWeight: number,
  multiplier: number,
): void {
  if (
    semanticWeight < 1 &&
    exactNameMatch(query, hit.sourceChunk.name)
  ) {
    hit.score *= multiplier;
  }
}
export function applyMeasuredReranking(
  hit: SearchHit,
  uniqueSymbolChunkIds: ReadonlySet<number>,
  uniqueSymbolMultiplier: number,
  testPathMultiplier: number,
  isGeneratedPath: (path: string) => boolean,
  generatedPathMultiplier: number,
): void {
  if (uniqueSymbolChunkIds.has(hit.sourceChunk.id)) {
    hit.score *= uniqueSymbolMultiplier;
  }
  if (isTestSourcePath(hit.path)) hit.score *= testPathMultiplier;
  if (isGeneratedPath(hit.path)) hit.score *= generatedPathMultiplier;
}
export function reciprocalRankScore(
  semanticRank: number | undefined,
  lexicalRank: number | undefined,
  semanticWeight: number,
  convention: "current" | "v1",
): number {
  if (convention === "v1") {
    const semantic = semanticRank === undefined
      ? 0
      : semanticWeight * SEARCH_RRF_K /
        (SEARCH_RRF_K + semanticRank - 1);
    const lexical = lexicalRank === undefined
      ? 0
      : (1 - semanticWeight) * SEARCH_RRF_K /
        (SEARCH_RRF_K + lexicalRank - 1);
    return semantic + lexical;
  }
  const semantic = semanticRank === undefined
    ? 0
    : semanticWeight / (SEARCH_RRF_K + semanticRank);
  const lexical = lexicalRank === undefined
    ? 0
    : (1 - semanticWeight) / (SEARCH_RRF_K + lexicalRank);
  return (semantic + lexical) * (SEARCH_RRF_K + 1);
}
export function compareHits(left: SearchHit, right: SearchHit): number {
  return right.score - left.score ||
    right.semanticScore - left.semanticScore ||
    compareText(left.path, right.path) ||
    left.window.startOffset - right.window.startOffset ||
    left.windowId - right.windowId;
}
