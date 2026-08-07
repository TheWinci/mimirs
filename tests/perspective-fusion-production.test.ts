import { describe, expect, test } from "bun:test";

import {
  FACT_CONFIRMATION_POLICY,
  fusePerspectiveCandidates,
} from "../src/internals/search/perspective-fusion.ts";
import type { PerspectiveSearchResponse } from
  "../src/internals/search/perspective-search.ts";
import type { SearchHit } from "../src/internals/search/types.ts";
import { SourceIndex } from
  "../src/internals/storage/source-index.ts";

function hit(index: SourceIndex, path: string, score: number): SearchHit {
  const window = index.loadWindows(path)[0]!;
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
    score,
    semanticScore: score,
    lexicalScore: 0,
    preview: window.text,
    windows: [{ id: window.id, ...range }],
    window: range,
    sourceChunks: [sourceChunk],
    sourceChunk,
  };
}

function perspectives(
  facts: string[],
  relations: string[] = [],
): PerspectiveSearchResponse {
  const diagnostics = {
    total: 1,
    embedded: 1,
    compatible: true,
    retrievedDocuments: 1,
  };
  return {
    facts: {
      results: facts.map((path, index) => ({
        path,
        score: 1 - index / 10,
        evidence: [],
      })),
      diagnostics,
    },
    relations: {
      results: relations.map((path, index) => ({
        path,
        score: 1 - index / 10,
        evidence: [],
      })),
      diagnostics,
    },
  };
}

describe("production perspective fusion", () => {
  test("attributes low-authority confirmation without losing citations", async () => {
    const index = SourceIndex.open();
    try {
      await index.indexFile("first.ts", "export const first = true;\n");
      await index.indexFile("second.ts", "export const second = true;\n");
      const production = [hit(index, "first.ts", 2), hit(index, "second.ts", 1)];
      const fused = fusePerspectiveCandidates(
        index,
        production,
        perspectives(["second.ts", "first.ts"]),
        FACT_CONFIRMATION_POLICY,
        200,
      );
      expect(fused.results.map((value) => value.path)).toEqual([
        "first.ts",
        "second.ts",
      ]);
      expect(fused.results.every((value) => value.windows.length > 0)).toBe(true);
      expect(fused.diagnostics.contributions[0]).toMatchObject({
        path: "first.ts",
        productionRank: 1,
        factRank: 2,
        relationRank: null,
      });
    } finally {
      index.close();
    }
  });

  test("hydrates a perspective-only file and reports its channel ranks", async () => {
    const index = SourceIndex.open();
    try {
      await index.indexFile("production.ts", "export const production = true;\n");
      await index.indexFile("fact-only.ts", "export const evidence = true;\n");
      const fused = fusePerspectiveCandidates(
        index,
        [hit(index, "production.ts", 1)],
        perspectives(["fact-only.ts"]),
        { factWeight: 2, relationWeight: 0, reciprocalRankK: 0 },
        200,
      );
      expect(fused.results.map((value) => value.path)).toEqual([
        "fact-only.ts",
        "production.ts",
      ]);
      expect(fused.diagnostics.hydratedCandidates).toBe(1);
      expect(fused.diagnostics.contributions[0]).toMatchObject({
        productionRank: null,
        factRank: 1,
      });
    } finally {
      index.close();
    }
  });

  test("rejects invalid policy values", () => {
    const index = SourceIndex.open();
    try {
      expect(() => fusePerspectiveCandidates(
        index,
        [],
        perspectives([]),
        { factWeight: Number.NaN, relationWeight: 0, reciprocalRankK: 60 },
        100,
      )).toThrow("factWeight");
    } finally {
      index.close();
    }
  });
});
