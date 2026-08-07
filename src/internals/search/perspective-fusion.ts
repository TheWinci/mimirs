import { isDocumentationPath } from "./document-search.ts";
import type {
  PerspectiveSearchResponse,
} from "./perspective-search.ts";
import type { SearchHit } from "./types.ts";
import { sourceTextPreview } from "../source/windows.ts";
import type { SourceIndex } from "../storage/source-index.ts";

export interface PerspectiveFusionPolicy {
  factWeight: number;
  relationWeight: number;
  reciprocalRankK: number;
}

/** Predeclared low-authority confirmation policy; promotion requires holdout evidence. */
export const FACT_CONFIRMATION_POLICY: Readonly<PerspectiveFusionPolicy> =
  Object.freeze({
    factWeight: 0.025,
    relationWeight: 0,
    reciprocalRankK: 60,
  });

export interface PerspectiveFusionContribution {
  path: string;
  score: number;
  productionRank: number | null;
  factRank: number | null;
  relationRank: number | null;
  productionContribution: number;
  factContribution: number;
  relationContribution: number;
}

export interface PerspectiveFusionDiagnostics {
  applied: boolean;
  policy: PerspectiveFusionPolicy | null;
  hydratedCandidates: number;
  omittedCandidates: number;
  contributions: PerspectiveFusionContribution[];
}

function rankMap(values: readonly { path: string }[]): Map<string, number> {
  const ranks = new Map<string, number>();
  for (let index = 0; index < values.length; index++) {
    const path = values[index]!.path;
    if (!ranks.has(path)) ranks.set(path, index + 1);
  }
  return ranks;
}

function validatePolicy(policy: PerspectiveFusionPolicy): void {
  for (const [name, value] of [
    ["factWeight", policy.factWeight],
    ["relationWeight", policy.relationWeight],
    ["reciprocalRankK", policy.reciprocalRankK],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`${name} must be finite and non-negative`);
    }
  }
}

function hydrate(
  index: SourceIndex,
  path: string,
  previewCharacters: number,
): SearchHit | null {
  if (isDocumentationPath(path)) return null;
  const window = index.loadWindows(path)[0];
  if (!window) return null;
  const range = {
    startOffset: window.startOffset,
    endOffset: window.endOffset,
    startLine: window.startLine,
    endLine: window.endLine,
  };
  const sourceChunk = {
    id: window.sourceChunkId,
    kind: window.sourceChunk.kind,
    name: window.sourceChunk.name,
    startOffset: window.sourceChunk.startOffset,
    endOffset: window.sourceChunk.endOffset,
    startLine: window.sourceChunk.startLine,
    endLine: window.sourceChunk.endLine,
  };
  return {
    windowId: window.id,
    path,
    score: 0,
    semanticScore: 0,
    lexicalScore: 0,
    preview: sourceTextPreview(window.text, previewCharacters),
    windows: [{ id: window.id, ...range }],
    window: range,
    sourceChunks: [sourceChunk],
    sourceChunk,
  };
}

/** Fuse file ranks while retaining source citations and channel-level attribution. */
export function fusePerspectiveCandidates(
  index: SourceIndex,
  production: readonly SearchHit[],
  perspectives: PerspectiveSearchResponse,
  policy: PerspectiveFusionPolicy,
  previewCharacters: number,
): { results: SearchHit[]; diagnostics: PerspectiveFusionDiagnostics } {
  validatePolicy(policy);
  const productionRanks = rankMap(production);
  const factRanks = rankMap(perspectives.facts.results);
  const relationRanks = rankMap(perspectives.relations.results);
  const paths = new Set([
    ...productionRanks.keys(),
    ...(policy.factWeight > 0 ? factRanks.keys() : []),
    ...(policy.relationWeight > 0 ? relationRanks.keys() : []),
  ]);
  const sourceHits = new Map(production.map((hit) => [hit.path, hit]));
  const contributions: PerspectiveFusionContribution[] = [];
  let hydratedCandidates = 0;
  let omittedCandidates = 0;
  for (const path of paths) {
    const productionRank = productionRanks.get(path) ?? null;
    const factRank = factRanks.get(path) ?? null;
    const relationRank = relationRanks.get(path) ?? null;
    const productionContribution = productionRank === null
      ? 0
      : 1 / (policy.reciprocalRankK + productionRank);
    const factContribution = factRank === null
      ? 0
      : policy.factWeight / (policy.reciprocalRankK + factRank);
    const relationContribution = relationRank === null
      ? 0
      : policy.relationWeight / (policy.reciprocalRankK + relationRank);
    const score = productionContribution + factContribution +
      relationContribution;
    let hit = sourceHits.get(path);
    if (!hit) {
      hit = hydrate(index, path, previewCharacters) ?? undefined;
      if (!hit) {
        omittedCandidates++;
        continue;
      }
      sourceHits.set(path, hit);
      hydratedCandidates++;
    }
    hit.score = score;
    contributions.push({
      path,
      score,
      productionRank,
      factRank,
      relationRank,
      productionContribution,
      factContribution,
      relationContribution,
    });
  }
  contributions.sort((left, right) =>
    right.score - left.score || left.path.localeCompare(right.path)
  );
  return {
    results: contributions.map((value) => sourceHits.get(value.path)!),
    diagnostics: {
      applied: true,
      policy: { ...policy },
      hydratedCandidates,
      omittedCandidates,
      contributions,
    },
  };
}

export function inactivePerspectiveFusion(): PerspectiveFusionDiagnostics {
  return {
    applied: false,
    policy: null,
    hydratedCandidates: 0,
    omittedCandidates: 0,
    contributions: [],
  };
}
