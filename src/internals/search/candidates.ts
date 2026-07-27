import {
  sourceTextPreview,
} from "../source/windows.ts";
import {
  type NativeWindowCandidate,
  type SemanticSourceChunk,
} from "../storage/source-index.ts";
import type {
  SearchWindowRange,
  SearchSourceChunk,
  SearchHit,
} from "./types.ts";
import {
  reciprocalRankScore,
  compareHits,
} from "./scoring.ts";

function searchChunk(chunk: SemanticSourceChunk): SearchSourceChunk {
  return {
    id: chunk.id,
    kind: chunk.kind,
    name: chunk.name,
    startOffset: chunk.startOffset,
    endOffset: chunk.endOffset,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
  };
}
export function searchHit(
  candidate: Omit<NativeWindowCandidate, "lexicalScore"> & {
    lexicalScore?: number;
  },
  previewCharacters: number,
): SearchHit {
  const sourceChunk = searchChunk(candidate.sourceChunk);
  const windowRange = {
    startOffset: candidate.startOffset,
    endOffset: candidate.endOffset,
    startLine: candidate.startLine,
    endLine: candidate.endLine,
  };
  const window = {
    id: candidate.id,
    ...windowRange,
  };
  return {
    windowId: candidate.id,
    path: candidate.path,
    score: 0,
    semanticScore: candidate.semanticScore,
    lexicalScore: candidate.lexicalScore ?? 0,
    preview: sourceTextPreview(candidate.text, previewCharacters),
    windows: [window],
    window: windowRange,
    sourceChunks: [sourceChunk],
    sourceChunk,
  };
}
function mergedWindows(hits: readonly SearchHit[]): SearchWindowRange[] {
  const windows = new Map<number, SearchWindowRange>();
  for (const hit of hits) {
    for (const window of hit.windows) windows.set(window.id, window);
  }
  return [...windows.values()].sort((left, right) =>
    left.startOffset - right.startOffset ||
    left.endOffset - right.endOffset ||
    left.id - right.id
  );
}
function mergedSourceChunks(hits: readonly SearchHit[]): SearchSourceChunk[] {
  const chunks = new Map<number, SearchSourceChunk>();
  for (const hit of hits) {
    for (const chunk of hit.sourceChunks) chunks.set(chunk.id, chunk);
  }
  return [...chunks.values()].sort((left, right) =>
    left.startOffset - right.startOffset ||
    left.endOffset - right.endOffset ||
    left.id - right.id
  );
}
export function groupedCandidateHits(
  candidates: Iterable<NativeWindowCandidate>,
  semanticRanks: ReadonlyMap<number, number>,
  lexicalRanks: ReadonlyMap<number, number>,
  groupByChunk: boolean,
  semanticWeight: number,
  fusionConvention: "current" | "v1",
  previewCharacters: number,
  applySignals: (hit: SearchHit) => void,
): SearchHit[] {
  const groups = new Map<number, NativeWindowCandidate[]>();
  for (const candidate of candidates) {
    const key = groupByChunk ? candidate.sourceChunk.id : candidate.id;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [candidate]);
    else group.push(candidate);
  }
  return [...groups.values()].map((group) => {
    const semanticRank = Math.min(...group.flatMap((candidate) => {
      const rank = semanticRanks.get(candidate.id);
      return rank === undefined ? [] : [rank];
    }));
    const lexicalRank = Math.min(...group.flatMap((candidate) => {
      const rank = lexicalRanks.get(candidate.id);
      return rank === undefined ? [] : [rank];
    }));
    const ranked = group.map((candidate) => ({
      candidate,
      score: reciprocalRankScore(
        semanticRanks.get(candidate.id),
        lexicalRanks.get(candidate.id),
        semanticWeight,
        fusionConvention,
      ),
    })).sort((left, right) =>
      right.score - left.score ||
      right.candidate.semanticScore - left.candidate.semanticScore ||
      left.candidate.path.localeCompare(right.candidate.path) ||
      left.candidate.startOffset - right.candidate.startOffset ||
      left.candidate.id - right.candidate.id
    );
    const groupHits = group.map((candidate) =>
      searchHit(candidate, previewCharacters)
    );
    const hit = searchHit(ranked[0]!.candidate, previewCharacters);
    hit.windows = mergedWindows(groupHits);
    hit.sourceChunks = mergedSourceChunks(groupHits);
    hit.semanticScore = Math.max(...group.map((candidate) =>
      candidate.semanticScore
    ));
    hit.lexicalScore = Math.max(...group.map((candidate) =>
      candidate.lexicalScore
    ));
    hit.score = reciprocalRankScore(
      Number.isFinite(semanticRank) ? semanticRank : undefined,
      Number.isFinite(lexicalRank) ? lexicalRank : undefined,
      semanticWeight,
      fusionConvention,
    );
    applySignals(hit);
    return hit;
  });
}
export function collapseCandidateFiles(
  hits: readonly SearchHit[],
  confirmationWeight: number,
): SearchHit[] {
  const byFile = new Map<string, SearchHit[]>();
  for (const hit of hits) {
    const file = byFile.get(hit.path);
    if (file === undefined) byFile.set(hit.path, [hit]);
    else file.push(hit);
  }
  return [...byFile.values()].map((fileHits) => {
    fileHits.sort(compareHits);
    const best = fileHits[0]!;
    const confirmation = fileHits[1];
    const score = confirmation === undefined
      ? best.score
      : best.score + confirmationWeight * Math.min(
        best.score,
        confirmation.score,
      );
    return {
      ...best,
      score,
      windows: mergedWindows(fileHits),
      sourceChunks: mergedSourceChunks(fileHits),
    };
  });
}
