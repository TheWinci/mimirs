import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import type { Embedder } from
  "../src/internals/embeddings/embedder.ts";
import { ProjectSearchSession } from
  "../src/internals/search/project-search.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "search-relevance");

class IntentEmbedder implements Embedder {
  readonly model = "test/search-relevance";
  readonly revision = "1";
  readonly variant = "intent-axes";
  readonly dimensions = 6;
  readonly calls: string[][] = [];

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    this.calls.push([...texts]);
    return texts.map((text) => {
      const normalized = text.toLowerCase();
      return new Float32Array([
        /retrycardcharge|exponential backoff|card payments? retr/.test(normalized)
          ? 1
          : 0,
        /redact_authorization|authorization.*(?:credential|header)|bearer.*(?:credential|log)/s
            .test(normalized)
          ? 1
          : 0,
        /gracefulshutdown|graceful shutdown|in-flight http|drain.*requests?/s
            .test(normalized)
          ? 1
          : 0,
        /synchronizecatalogbatch|catalog (?:batch|synchronization)/
            .test(normalized)
          ? 1
          : 0,
        /record[_a-z]*audit[_a-z]*event|audit record/.test(normalized) ? 0.2 : 0,
        0.05,
      ]);
    });
  }
}

async function openFixture(embedder: IntentEmbedder) {
  const session = await ProjectSearchSession.open(FIXTURE, {
    databasePath: ":memory:",
    config: { include: ["src/**/*"], exclude: [] },
    embedder,
    previewCharacters: 72,
    targetCharacters: 220,
  });
  await session.refresh();
  return session;
}

describe("search relevance project", () => {
  test("retrieves identifier, prose, and non-TypeScript intent through the full path", async () => {
    const embedder = new IntentEmbedder();
    const session = await openFixture(embedder);
    try {
      const identifier = await session.search({
        query: "retryCardChargeWithExponentialBackoff",
        maxResults: 3,
      });
      expect(identifier.source[0]).toMatchObject({
        path: "src/payments/retry.ts",
        sourceChunk: {
          kind: "function",
          name: "retryCardChargeWithExponentialBackoff",
        },
      });
      expect(identifier.source[0]!.preview).toContain("Retry a card charge");

      const prose = await session.search({
        query: "Where are bearer authorization credentials removed before logs?",
        maxResults: 3,
      });
      expect(prose.source[0]).toMatchObject({
        path: "src/security/redact.py",
        sourceChunk: {
          kind: "function",
          name: "redact_authorization_header",
        },
      });

      const nonTypeScript = await session.search({
        query: "How do we drain in-flight HTTP requests during graceful shutdown?",
        maxResults: 3,
      });
      expect(nonTypeScript.source[0]).toMatchObject({
        path: "src/server/shutdown.go",
        sourceChunk: { kind: "function", name: "GracefulShutdown" },
      });

      for (const response of [identifier, prose, nonTypeScript]) {
        const hit = response.source[0]!;
        expect(hit.semanticScore).toBeGreaterThan(0.9);
        expect(hit.window.startOffset).toBeGreaterThanOrEqual(
          hit.sourceChunk.startOffset,
        );
        expect(hit.window.endOffset).toBeLessThanOrEqual(
          hit.sourceChunk.endOffset,
        );
        expect(hit.window.startLine).toBeGreaterThanOrEqual(
          hit.sourceChunk.startLine,
        );
        expect(hit.window.endLine).toBeLessThanOrEqual(
          hit.sourceChunk.endLine,
        );
      }
    } finally {
      await session.close();
    }
  });

  test("distinct behavior outranks duplicated audit boilerplate", async () => {
    const session = await openFixture(new IntentEmbedder());
    try {
      const response = await session.search({
        query: "Where does retrying card payments use exponential backoff?",
        maxResults: 100,
      });
      expect(response.source[0]!.path).toBe("src/payments/retry.ts");
      expect(response.source[0]!.sourceChunk.name).toBe(
        "retryCardChargeWithExponentialBackoff",
      );
      const boilerplate = response.source.find(
        (result) => result.path === "src/observability/audit.ts",
      );
      expect(boilerplate).toBeDefined();
      expect(response.source[0]!.score).toBeGreaterThan(boilerplate!.score);
    } finally {
      await session.close();
    }
  });

  test("merges sibling windows and source chunks into one file citation", async () => {
    const embedder = new IntentEmbedder();
    const session = await openFixture(embedder);
    try {
      const query = `${"explain the implementation context in detail ".repeat(80)}` +
        "synchronizeCatalogBatch catalog synchronization";
      const response = await session.search({ query, maxResults: 20 });
      const windows = response.source.filter((result) =>
        result.path === "src/catalog/synchronize.ts" &&
        result.sourceChunk.name === "synchronizeCatalogBatch"
      );

      expect(windows).toHaveLength(1);
      expect(windows[0]!.windows.length).toBeGreaterThan(1);
      expect(windows[0]!.windows).toContainEqual({
        id: windows[0]!.windowId,
        ...windows[0]!.window,
      });
      expect(windows[0]!.sourceChunks.length).toBeGreaterThan(1);
      expect(windows[0]!.sourceChunks).toContainEqual(
        windows[0]!.sourceChunk,
      );
      expect(new Set(windows[0]!.sourceChunks.map((chunk) => chunk.id)).size)
        .toBe(windows[0]!.sourceChunks.length);
      expect(windows[0]!.sourceChunks.map((chunk) => chunk.startOffset))
        .toEqual(
          windows[0]!.sourceChunks.map((chunk) => chunk.startOffset)
            .toSorted((left, right) => left - right),
        );
      expect(windows[0]!.sourceChunk.startOffset)
        .toBeLessThanOrEqual(windows[0]!.window.startOffset);
      expect(windows[0]!.window.endOffset)
        .toBeLessThanOrEqual(windows[0]!.sourceChunk.endOffset);
      expect(embedder.calls.at(-1)).toEqual([query]);
      expect(query.length).toBeGreaterThan(2_000);
    } finally {
      await session.close();
    }
  });
});
