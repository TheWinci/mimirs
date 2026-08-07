import { describe, expect, test } from "bun:test";

import type { Embedder } from
  "../src/internals/embeddings/embedder.ts";
import { searchPerspectiveCandidates } from
  "../src/internals/search/perspective-search.ts";
import { searchRelationCandidates } from
  "../src/internals/search/relation-search.ts";
import { connectSourceFiles } from
  "../src/internals/source/relationships.ts";
import { embedFactDocuments, factDocumentEmbedder } from
  "../src/internals/storage/fact-embeddings.ts";
import {
  embedRelationDocuments,
  relationDocumentEmbedder,
} from "../src/internals/storage/relation-embeddings.ts";
import { SourceIndex } from
  "../src/internals/storage/source-index.ts";

class PerspectiveEmbedder implements Embedder {
  readonly model = "test/perspectives";
  readonly revision = "1";
  readonly dimensions = 2;
  readonly calls: string[][] = [];

  constructor(readonly variant = "deterministic") {}

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    this.calls.push([...texts]);
    return texts.map((text) => {
      const normalized = text.toLowerCase();
      if (normalized.includes("worker")) return new Float32Array([1, 0]);
      if (normalized.includes("entry")) return new Float32Array([0, 1]);
      return new Float32Array([Math.SQRT1_2, Math.SQRT1_2]);
    });
  }
}

async function project(index: SourceIndex) {
  await index.indexFile(
    "worker.ts",
    "export function worker() { return true; }\n",
  );
  await index.indexFile(
    "entry.ts",
    "import { worker } from './worker.ts';\n" +
      "export function entry() { return worker(); }\n",
  );
  return connectSourceFiles(index.loadAnalyzedFiles());
}

describe("relationship-document embeddings", () => {
  test("materializes typed edges in both directions and searches provenance", async () => {
    const index = SourceIndex.open();
    const base = new PerspectiveEmbedder();
    const embedder = relationDocumentEmbedder(base);
    try {
      const relationships = await project(index);
      const first = await embedRelationDocuments(index, relationships, embedder, {
        batchSize: 1,
      });
      expect(first.total).toBeGreaterThanOrEqual(2);
      expect(first).toMatchObject({
        embedded: first.total,
        unchanged: 0,
        projectedFiles: 2,
        changedProjectionFiles: 2,
      });
      expect(index.countRelationVectors()).toBe(first.total);

      base.calls.length = 0;
      expect(await embedRelationDocuments(index, relationships, embedder))
        .toMatchObject({
          total: first.total,
          embedded: 0,
          unchanged: first.total,
          changedProjectionFiles: 0,
        });
      expect(base.calls).toEqual([]);

      const response = await searchRelationCandidates(index, {
        query: "who calls worker",
        maxResults: 2,
      }, { embedder });
      expect(response.results.some((result) => result.path === "worker.ts"))
        .toBe(true);
      const evidence = response.results.flatMap((result) => result.evidence);
      expect(evidence.some((value) =>
        value.direction === "incoming" && value.relationKind === "call"
      )).toBe(true);
      expect(evidence.some((value) => value.text.includes("Called by"))).toBe(true);
    } finally {
      index.close();
    }
  });

  test("reprojects both endpoints after an edge changes", async () => {
    const index = SourceIndex.open();
    const base = new PerspectiveEmbedder();
    const embedder = relationDocumentEmbedder(base);
    try {
      let relationships = await project(index);
      const first = await embedRelationDocuments(index, relationships, embedder);
      await index.indexFile(
        "entry.ts",
        "export function entry() { return false; }\n",
      );
      relationships = connectSourceFiles(index.loadAnalyzedFiles());
      const changed = await embedRelationDocuments(index, relationships, embedder);
      expect(changed.changedProjectionFiles).toBe(1);
      expect(changed.total).toBeLessThan(first.total);
      expect(index.countRelationVectors()).toBe(changed.total);
    } finally {
      index.close();
    }
  });

  test("retrieves fact and relation pools with one query inference", async () => {
    const index = SourceIndex.open();
    const base = new PerspectiveEmbedder();
    try {
      const relationships = await project(index);
      await embedFactDocuments(index, factDocumentEmbedder(base));
      await embedRelationDocuments(
        index,
        relationships,
        relationDocumentEmbedder(base),
      );
      base.calls.length = 0;
      const response = await searchPerspectiveCandidates(index, {
        query: "worker",
        maxResults: 2,
      }, { embedder: base });
      expect(base.calls).toEqual([["worker"]]);
      expect(response.facts.results.length).toBeGreaterThan(0);
      expect(response.relations.results.length).toBeGreaterThan(0);
    } finally {
      index.close();
    }
  });
});
