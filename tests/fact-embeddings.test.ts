import { describe, expect, test } from "bun:test";

import type { Embedder } from
  "../src/internals/embeddings/embedder.ts";
import { searchFactCandidates } from
  "../src/internals/search/fact-search.ts";
import { embedFactDocuments } from
  "../src/internals/storage/fact-embeddings.ts";
import { SourceIndex } from
  "../src/internals/storage/source-index.ts";

class FactEmbedder implements Embedder {
  readonly model = "test/facts";
  readonly revision = "1";
  readonly dimensions = 2;
  readonly calls: string[][] = [];

  constructor(readonly variant = "deterministic") {}

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    this.calls.push([...texts]);
    return texts.map((text) => {
      const normalized = text.toLowerCase();
      if (normalized.includes("worker")) return new Float32Array([1, 0]);
      if (normalized.includes("logger")) return new Float32Array([0, 1]);
      return new Float32Array([Math.SQRT1_2, Math.SQRT1_2]);
    });
  }
}

describe("fact-document embeddings", () => {
  test("materializes, incrementally embeds, and searches facts with provenance", async () => {
    const index = SourceIndex.open();
    const embedder = new FactEmbedder();
    try {
      await index.indexFile(
        "src/worker.ts",
        "export function worker() { return true; }\n",
      );
      await index.indexFile(
        "src/logger.ts",
        "export function logger() { return true; }\n",
      );
      const progress: Array<{ completed: number; total: number }> = [];
      const first = await embedFactDocuments(index, embedder, {
        batchSize: 1,
        onProgress: (value) => {
          progress.push(value);
        },
      });
      expect(first.total).toBeGreaterThanOrEqual(2);
      expect(first).toMatchObject({
        embedded: first.total,
        unchanged: 0,
        projectedFiles: 2,
        changedProjectionFiles: 2,
      });
      expect(index.countFactDocuments()).toBe(first.total);
      expect(index.countFactVectors()).toBe(first.total);
      expect(progress.at(-1)).toEqual({ completed: first.total, total: first.total });

      embedder.calls.length = 0;
      expect(await embedFactDocuments(index, embedder)).toMatchObject({
        total: first.total,
        embedded: 0,
        unchanged: first.total,
        changedProjectionFiles: 0,
      });
      expect(embedder.calls).toEqual([]);

      const result = await searchFactCandidates(index, {
        query: "worker function",
        maxResults: 2,
      }, { embedder });
      expect(result.results[0]).toMatchObject({
        path: "src/worker.ts",
        evidence: [{
          startOffset: 0,
        }],
      });
      expect(result.results[0]!.evidence[0]!.text).toContain("Exports worker");
      expect(result.diagnostics).toMatchObject({
        total: first.total,
        embedded: first.total,
        compatible: true,
      });
    } finally {
      index.close();
    }
  });

  test("invalidates only changed or removed files and resets a changed space", async () => {
    const index = SourceIndex.open();
    const embedder = new FactEmbedder();
    try {
      await index.indexFile("worker.ts", "export const worker = () => true;\n");
      await index.indexFile("logger.ts", "export const logger = () => true;\n");
      const initial = await embedFactDocuments(index, embedder);

      await index.indexFile(
        "worker.ts",
        "export const worker = () => false;\nexport const workerState = 1;\n",
      );
      const changed = await embedFactDocuments(index, embedder);
      expect(changed.changedProjectionFiles).toBe(1);
      expect(changed.embedded).toBeGreaterThan(0);
      expect(changed.embedded).toBeLessThan(changed.total);

      index.reconcileFiles(new Set(["worker.ts"]));
      expect(index.countFactDocuments()).toBeLessThan(changed.total);
      expect(index.countFactVectors()).toBe(index.countFactDocuments());

      const replacement = new FactEmbedder("replacement");
      const reset = await embedFactDocuments(index, replacement);
      expect(reset).toMatchObject({
        embedded: reset.total,
        unchanged: 0,
        changedProjectionFiles: 0,
      });
    } finally {
      index.close();
    }
  });

  test("validates independent fact-search requests", async () => {
    const index = SourceIndex.open();
    try {
      await expect(searchFactCandidates(index, {
        query: " ",
        maxResults: 1,
      }, { embedder: new FactEmbedder() })).rejects.toThrow("must not be empty");
      await expect(searchFactCandidates(index, {
        query: "worker",
        maxResults: 0,
      }, { embedder: new FactEmbedder() })).rejects.toThrow("must be positive");
    } finally {
      index.close();
    }
  });

  test("accepts persisted structural chunks that project to no source window", async () => {
    const index = SourceIndex.open();
    try {
      await index.indexFile("empty.md", "\n");
      const summary = await embedFactDocuments(index, new FactEmbedder());
      expect(summary).toMatchObject({ total: 0, embedded: 0 });
      expect(index.loadAnalyzedFiles()).toHaveLength(1);
    } finally {
      index.close();
    }
  });
});
