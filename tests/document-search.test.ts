import { describe, expect, test } from "bun:test";

import {
  extractStrictDocumentReferences,
  segmentSearchResults,
} from "../src/internals/search/document-search.ts";
import type { Embedder } from
  "../src/internals/embeddings/embedder.ts";
import { search, type SearchHit } from "../src/internals/search/search.ts";
import type { IndexedSourceWindow } from
  "../src/internals/storage/source-index.ts";
import { SourceIndex } from
  "../src/internals/storage/source-index.ts";

const embedder: Embedder = {
  model: "test/document-search",
  revision: "1",
  variant: "controlled",
  dimensions: 2,
  embed: async (texts) => texts.map(() => new Float32Array([1, 0])),
};

function hit(window: IndexedSourceWindow, score: number, preview?: string): SearchHit {
  return {
    windowId: window.id,
    path: window.path,
    score,
    semanticScore: score,
    lexicalScore: 0,
    preview: preview ?? window.text,
    windows: [{
      id: window.id,
      startOffset: window.startOffset,
      endOffset: window.endOffset,
      startLine: window.startLine,
      endLine: window.endLine,
    }],
    window: {
      startOffset: window.startOffset,
      endOffset: window.endOffset,
      startLine: window.startLine,
      endLine: window.endLine,
    },
    sourceChunks: [{
      id: window.sourceChunkId,
      kind: window.sourceChunk.kind,
      name: window.sourceChunk.name,
      startOffset: window.sourceChunk.startOffset,
      endOffset: window.sourceChunk.endOffset,
      startLine: window.sourceChunk.startLine,
      endLine: window.sourceChunk.endLine,
    }],
    sourceChunk: {
      id: window.sourceChunkId,
      kind: window.sourceChunk.kind,
      name: window.sourceChunk.name,
      startOffset: window.sourceChunk.startOffset,
      endOffset: window.sourceChunk.endOffset,
      startLine: window.sourceChunk.startLine,
      endLine: window.sourceChunk.endLine,
    },
  };
}

async function indexedPair(index: SourceIndex): Promise<{
  code: IndexedSourceWindow;
  document: IndexedSourceWindow;
}> {
  await index.indexFile(
    "src/state.ts",
    "export class ProjectState {\n  ready = true;\n}\n",
  );
  await index.indexFile(
    "docs/guide.md",
    "This deliberately long introduction pushes the citation past a compact preview.\n" +
      "Use [the state implementation](../src/state.ts).\n",
  );
  return {
    code: index.loadWindows("src/state.ts")[0]!,
    document: index.loadWindows("docs/guide.md")[0]!,
  };
}

describe("segmented documentation search", () => {
  test("extracts only explicit paths and qualified symbols", () => {
    expect(extractStrictDocumentReferences(
      "Use `ProjectState`, ProjectState, src.state.ProjectState, and " +
        "[the implementation](../src/state.ts).",
    )).toEqual([
      { value: "../src/state.ts", kind: "path" },
      { value: "src.state.ProjectState", kind: "qualified-symbol" },
    ]);
  });

  test("reads full document windows when previews omit a reference", async () => {
    const index = SourceIndex.open();
    try {
      const { code, document } = await indexedPair(index);
      const segmented = segmentSearchResults(
        index,
        [hit(document, 0.9, "This deliberately long…")],
        new Set([code.path, document.path]),
        1,
        24,
      );

      expect(segmented.docs.map((value) => value.path)).toEqual([
        "docs/guide.md",
      ]);
      expect(segmented.source.map((value) => value.path)).toEqual([
        "src/state.ts",
      ]);
      expect(segmented.source[0]!.preview.length).toBeLessThanOrEqual(24);
      expect(segmented.relations).toMatchObject([{
        documentWindowId: document.id,
        documentPath: "docs/guide.md",
        sourceWindowId: code.id,
        sourcePath: "src/state.ts",
        sourceRange: null,
        reference: "../src/state.ts",
        symbol: null,
        kind: "path",
        inheritedScore: 0.54,
      }]);
    } finally {
      index.close();
    }
  });

  test("inherits the document's best score from a lower-ranked cited window", async () => {
    const index = SourceIndex.open();
    try {
      await index.indexFile(
        "src/state.ts",
        "export class ProjectState { ready = true; }\n",
      );
      await index.indexFile(
        "docs/guide.md",
        "A highly relevant introduction occupies the first document window.\n" +
          "Additional detail lives in the middle without a citation.\n" +
          "Use [the implementation](../src/state.ts).\n",
        { targetCharacters: 64 },
      );
      const windows = index.loadWindows("docs/guide.md");
      expect(windows.length).toBeGreaterThan(1);
      const cited = windows.find((window) => window.text.includes("../src/state.ts"))!;
      const other = windows.find((window) => window.id !== cited.id)!;
      const segmented = segmentSearchResults(
        index,
        [hit(other, 0.9), hit(cited, 0.2)],
        new Set(["docs/guide.md", "src/state.ts"]),
        5,
        96,
      );

      expect(segmented.relations).toMatchObject([{
        documentWindowId: cited.id,
        inheritedScore: 0.54,
      }]);
      expect(segmented.source[0]!.score).toBeCloseTo(0.54, 8);
    } finally {
      index.close();
    }
  });

  test("returns an exact definition range for a qualified symbol", async () => {
    const index = SourceIndex.open();
    try {
      await index.indexFile(
        "src/state.ts",
        "const before = true;\nexport class ProjectState {\n  ready = true;\n}\n",
      );
      await index.indexFile(
        "README.md",
        "The value is a src.state.ProjectState instance.\n",
      );
      const code = index.loadWindows("src/state.ts").find((window) =>
        window.sourceChunk.name === "ProjectState"
      )!;
      const document = index.loadWindows("README.md")[0]!;
      const segmented = segmentSearchResults(
        index,
        [hit(document, 1)],
        new Set([code.path, document.path]),
        1,
        96,
      );

      expect(segmented.relations).toMatchObject([{
        sourcePath: "src/state.ts",
        sourceRange: {
          startOffset: code.sourceChunk.startOffset,
          endOffset: code.sourceChunk.endOffset,
          startLine: code.sourceChunk.startLine,
          endLine: code.sourceChunk.endLine,
        },
        symbol: "ProjectState",
        kind: "qualified-symbol",
      }]);
    } finally {
      index.close();
    }
  });

  test("public search keeps docs outside the requested source cap", async () => {
    const index = SourceIndex.open();
    try {
      const { code, document } = await indexedPair(index);
      index.storeWindowEmbeddings(embedder, [
        { windowId: code.id, textHash: code.textHash, vector: new Float32Array([0, 1]) },
        {
          windowId: document.id,
          textHash: document.textHash,
          vector: new Float32Array([1, 0]),
        },
      ]);

      const response = await search(index, {
        query: "state implementation guide",
        maxResults: 1,
      }, { embedder });

      expect(response.source).toHaveLength(1);
      expect(response.source[0]!.path).toBe("src/state.ts");
      expect(response.docs.map((value) => value.path)).toEqual([
        "docs/guide.md",
      ]);
      expect(response.relations).toHaveLength(1);
    } finally {
      index.close();
    }
  });

  test("public search resolves references from every aggregated document window", async () => {
    const index = SourceIndex.open();
    try {
      await index.indexFile(
        "src/state.ts",
        "export class ProjectState { ready = true; }\n",
      );
      await index.indexFile(
        "docs/guide.md",
        "# Overview\n\n" +
          "This introduction explains the project without naming any source file.\n\n" +
          "# Implementation\n\n" +
          "Use [the state implementation](../src/state.ts).\n",
        { targetCharacters: 64 },
      );
      const code = index.loadWindows("src/state.ts")[0]!;
      const documents = index.loadWindows("docs/guide.md");
      expect(documents.length).toBeGreaterThan(1);
      const cited = documents.find((window) =>
        window.text.includes("../src/state.ts")
      )!;
      expect(cited.id).not.toBe(documents[0]!.id);
      index.storeWindowEmbeddings(embedder, [
        {
          windowId: code.id,
          textHash: code.textHash,
          vector: new Float32Array([0, 1]),
        },
        ...documents.map((window) => ({
          windowId: window.id,
          textHash: window.textHash,
          vector: new Float32Array([1, 0]),
        })),
      ]);

      const response = await search(index, {
        query: "semantic documentation intent",
        maxResults: 5,
      }, { embedder });

      expect(response.docs).toHaveLength(1);
      expect(response.docs[0]!.windows.map((window) => window.id)).toContain(
        cited.id,
      );
      expect(response.relations).toMatchObject([{
        documentWindowId: cited.id,
        documentPath: "docs/guide.md",
        sourcePath: "src/state.ts",
        reference: "../src/state.ts",
        kind: "path",
      }]);
    } finally {
      index.close();
    }
  });

  test("does not resolve references outside the active project paths", async () => {
    const index = SourceIndex.open();
    try {
      const { document } = await indexedPair(index);
      const segmented = segmentSearchResults(
        index,
        [hit(document, 1)],
        new Set([document.path]),
        5,
        96,
      );
      expect(segmented.source).toEqual([]);
      expect(segmented.docs).toHaveLength(1);
      expect(segmented.relations).toEqual([]);
    } finally {
      index.close();
    }
  });
});
