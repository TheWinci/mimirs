import { describe, expect, test } from "bun:test";

import type { Embedder } from
  "../src/internals/embeddings/embedder.ts";
import {
  MAX_SEARCH_RESULTS,
  SEARCH_CANDIDATE_AGGREGATION,
  SEARCH_CANDIDATE_LIMIT,
  SEARCH_COMPLETE_MISSING_CANDIDATE_SCORES,
  SEARCH_FILE_CONFIRMATION_WEIGHT,
  SEARCH_SEMANTIC_CANDIDATE_LIMIT,
  SEARCH_SEMANTIC_WEIGHT,
  SEARCH_EXACT_NAME_MULTIPLIER,
  SEARCH_GENERATED_PATH_MULTIPLIER,
  SEARCH_TEST_PATH_MULTIPLIER,
  SEARCH_UNIQUE_SYMBOL_MULTIPLIER,
  searchCandidates as search,
} from "../src/internals/search/search.ts";
import { generatedPathMatcher } from
  "../src/internals/search/signals.ts";
import { SourceIndex } from
  "../src/internals/storage/source-index.ts";

class QueryEmbedder implements Embedder {
  readonly model = "test/search";
  readonly revision = "1";
  readonly variant = "controlled";
  readonly dimensions = 2;
  readonly calls: string[][] = [];

  constructor(
    readonly output: () => readonly Float32Array[] = () => [
      new Float32Array([1, 0]),
    ],
  ) {}

  async embed(texts: readonly string[]): Promise<readonly Float32Array[]> {
    this.calls.push([...texts]);
    return this.output();
  }
}

async function addEmbeddedFile(
  index: SourceIndex,
  embedder: Embedder,
  path: string,
  vector: Float32Array,
  source = `export function ${path.replace(/\W/g, "_")}() { return true; }\n`,
): Promise<void> {
  await index.indexFile(path, source);
  const window = index.loadWindows(path)[0]!;
  index.storeWindowEmbeddings(embedder, [{
    windowId: window.id,
    textHash: window.textHash,
    vector,
  }]);
}

describe("programmatic search", () => {
  test("pins the selected completed-score production fusion", () => {
    expect(SEARCH_CANDIDATE_LIMIT).toBe(100);
    expect(SEARCH_SEMANTIC_CANDIDATE_LIMIT).toBe(150);
    expect(SEARCH_COMPLETE_MISSING_CANDIDATE_SCORES).toBe(true);
    expect(SEARCH_CANDIDATE_AGGREGATION).toBe("chunk-file");
    expect(SEARCH_FILE_CONFIRMATION_WEIGHT).toBe(0.25);
    expect(SEARCH_SEMANTIC_WEIGHT).toBe(0.6);
  });

  test("ranks every finite cosine score and returns exact compact citations", async () => {
    const index = SourceIndex.open();
    const embedder = new QueryEmbedder();
    try {
      await addEmbeddedFile(
        index,
        embedder,
        "zeta.ts",
        new Float32Array([1, 1]),
        "export function zeta() {\n  return 'a long unicode 🧭 result';\n}\n",
      );
      await addEmbeddedFile(
        index,
        embedder,
        "alpha.ts",
        new Float32Array([1, 0]),
      );
      await addEmbeddedFile(
        index,
        embedder,
        "neutral.ts",
        new Float32Array([0, 1]),
      );
      await addEmbeddedFile(
        index,
        embedder,
        "opposite.ts",
        new Float32Array([-1, 0]),
      );

      const query = "  find the relevant behavior 🧭  ";
      const response = await search(index, { query, maxResults: 10 }, {
        embedder,
        previewCharacters: 24,
      });

      expect(embedder.calls).toEqual([[query]]);
      expect(response.results.map((result) => result.path)).toEqual([
        "alpha.ts",
        "zeta.ts",
        "neutral.ts",
        "opposite.ts",
      ]);
      expect(response.results[0]!.semanticScore).toBe(1);
      expect(response.results[1]!.semanticScore).toBeCloseTo(
        1 / Math.sqrt(2),
        6,
      );
      expect(response.results[2]!.semanticScore).toBe(0);
      expect(response.results[3]!.semanticScore).toBe(-1);
      expect(response.results.map((result) => result.lexicalScore)).toEqual([
        0,
        0,
        0,
        0,
      ]);
      expect(response.results.every((result) =>
        result.score > 0 && result.score <= 1
      )).toBe(true);
      expect(response.results[1]!.preview).toBe("export function zeta()…");
      expect(response.diagnostics).toEqual({
        total: 4,
        compatible: 4,
        missingEmbedding: 0,
        incompleteEmbedding: 0,
        incompatibleEmbedding: 0,
        malformedEmbedding: 0,
        orphaned: 0,
        unscorableCandidates: 0,
        lexicalCandidates: 0,
      });

      const alpha = index.loadWindows("alpha.ts")[0]!;
      expect(response.results[0]).toMatchObject({
        windowId: alpha.id,
        path: "alpha.ts",
        window: {
          startOffset: alpha.startOffset,
          endOffset: alpha.endOffset,
          startLine: alpha.startLine,
          endLine: alpha.endLine,
        },
        sourceChunk: {
          kind: alpha.sourceChunk.kind,
          name: alpha.sourceChunk.name,
          startOffset: alpha.sourceChunk.startOffset,
          endOffset: alpha.sourceChunk.endOffset,
          startLine: alpha.sourceChunk.startLine,
          endLine: alpha.sourceChunk.endLine,
        },
      });
      expect(alpha.text).toContain("return true");
    } finally {
      index.close();
    }
  });

  test("uses a stable path and range tie-break independent of insertion order", async () => {
    const index = SourceIndex.open();
    const embedder = new QueryEmbedder();
    try {
      await addEmbeddedFile(index, embedder, "zeta.ts", new Float32Array([1, 0]));
      await addEmbeddedFile(index, embedder, "alpha.ts", new Float32Array([1, 0]));
      const first = await search(index, { query: "tie", maxResults: 2 }, {
        embedder,
      });
      const second = await search(index, { query: "tie", maxResults: 2 }, {
        embedder,
      });
      expect(first.results.map((result) => result.path)).toEqual([
        "alpha.ts",
        "zeta.ts",
      ]);
      expect(second.results).toEqual(first.results);
    } finally {
      index.close();
    }
  });

  test("keeps duplicate source text as independently cited results", async () => {
    const index = SourceIndex.open();
    const embedder = new QueryEmbedder();
    const source = "export function shared() { return 1; }\n";
    try {
      await addEmbeddedFile(
        index,
        embedder,
        "a.ts",
        new Float32Array([1, 0]),
        source,
      );
      await addEmbeddedFile(
        index,
        embedder,
        "b.ts",
        new Float32Array([1, 0]),
        source,
      );
      const response = await search(index, { query: "shared", maxResults: 20 }, {
        embedder,
      });
      expect(response.results.map((result) => result.path)).toEqual([
        "a.ts",
        "b.ts",
      ]);
      expect(new Set(response.results.map((result) => result.windowId)).size)
        .toBe(2);
    } finally {
      index.close();
    }
  });

  test("fuses identifier evidence by rank without replacing cosine evidence", async () => {
    const index = SourceIndex.open();
    const embedder = new QueryEmbedder();
    try {
      await addEmbeddedFile(
        index,
        embedder,
        "src/semantic.ts",
        new Float32Array([1, 0]),
        "export function unrelated() { return true; }\n",
      );
      await addEmbeddedFile(
        index,
        embedder,
        "src/cli/commands/init.ts",
        new Float32Array([0, 1]),
        "export function initCommand() { return setupProject(); }\n",
      );

      const hybrid = await search(index, {
        query: "initCommand project setup",
        maxResults: 2,
      }, { embedder });
      expect(hybrid.results.map((result) => result.path)).toEqual([
        "src/cli/commands/init.ts",
        "src/semantic.ts",
      ]);
      expect(hybrid.results[0]).toMatchObject({
        semanticScore: 0,
      });
      expect(hybrid.results[0]!.lexicalScore).toBeGreaterThan(0);
      expect(hybrid.diagnostics.lexicalCandidates).toBe(1);

      const semanticOnly = await search(index, {
        query: "initCommand project setup",
        maxResults: 2,
      }, { embedder, semanticWeight: 1 });
      expect(semanticOnly.results.map((result) => result.path)).toEqual([
        "src/semantic.ts",
        "src/cli/commands/init.ts",
      ]);
      expect(semanticOnly.results.map((result) => result.semanticScore))
        .toEqual([1, 0]);
    } finally {
      index.close();
    }
  });

  test("applies the measured exact-name signal", async () => {
    const index = SourceIndex.open();
    const embedder = new QueryEmbedder();
    try {
      await addEmbeddedFile(
        index,
        embedder,
        "src/init.ts",
        new Float32Array([1, 0]),
        "export function initCommand() { return setupProject(); }\n",
      );
      const response = await search(index, {
        query: "init command project setup",
        maxResults: 1,
      }, { embedder });
      expect(response.results[0]!.sourceChunk.name).toBe("initCommand");
      expect(response.results[0]!.score).toBeCloseTo(
        SEARCH_EXACT_NAME_MULTIPLIER,
        8,
      );
      const disabled = await search(index, {
        query: "init command project setup",
        maxResults: 1,
      }, { embedder, exactNameMultiplier: 1 });
      expect(disabled.results[0]!.score).toBeCloseTo(1, 8);
    } finally {
      index.close();
    }
  });

  test("demotes conventional test paths without boosting source directories", async () => {
    const index = SourceIndex.open();
    const embedder = new QueryEmbedder();
    try {
      await addEmbeddedFile(
        index,
        embedder,
        "a.test.ts",
        new Float32Array([1, 0]),
      );
      await addEmbeddedFile(index, embedder, "z.ts", new Float32Array([1, 0]));
      const disabled = await search(index, {
        query: "behavior with no matching source terms",
        maxResults: 2,
      }, { embedder, testPathMultiplier: 1 });
      expect(disabled.results.map((result) => result.path)).toEqual([
        "a.test.ts",
        "z.ts",
      ]);

      const measured = await search(index, {
        query: "behavior with no matching source terms",
        maxResults: 2,
      }, { embedder });
      expect(measured.results.map((result) => result.path)).toEqual([
        "z.ts",
        "a.test.ts",
      ]);
      expect(measured.results[1]!.score).toBeCloseTo(
        disabled.results[0]!.score * SEARCH_TEST_PATH_MULTIPLIER,
        8,
      );
    } finally {
      index.close();
    }
  });

  test("demotes configured generated paths in native and exact search", async () => {
    const index = SourceIndex.open();
    const embedder = new QueryEmbedder();
    try {
      await addEmbeddedFile(
        index,
        embedder,
        "staging/applyconfigurations/generated.ts",
        new Float32Array([1, 0]),
      );
      await addEmbeddedFile(
        index,
        embedder,
        "src/handwritten.ts",
        new Float32Array([1, 0]),
      );
      const request = {
        query: "behavior with no matching source terms",
        maxResults: 2,
      };
      const generatedPatterns = ["applyconfigurations/**"];
      const disabled = await search(index, request, {
        embedder,
        generatedPatterns,
        generatedPathMultiplier: 1,
      });
      const measured = await search(index, request, {
        embedder,
        generatedPatterns,
      });
      expect(measured.results.map((result) => result.path)).toEqual([
        "src/handwritten.ts",
        "staging/applyconfigurations/generated.ts",
      ]);
      const generated = measured.results.find((result) =>
        result.path.includes("applyconfigurations")
      )!;
      const generatedWithoutDemotion = disabled.results.find((result) =>
        result.path.includes("applyconfigurations")
      )!;
      expect(generated.score).toBeCloseTo(
        generatedWithoutDemotion.score * SEARCH_GENERATED_PATH_MULTIPLIER,
        8,
      );

      const exact = await search(index, request, {
        embedder,
        engine: "exact",
        generatedPatterns,
      });
      expect(exact.results.map((result) => result.path)).toEqual([
        "src/handwritten.ts",
        "staging/applyconfigurations/generated.ts",
      ]);
      expect(measured.results).toHaveLength(2);
    } finally {
      index.close();
    }
  });

  test("matches generated globs at the root or a directory suffix", () => {
    const matches = generatedPathMatcher([
      "applyconfigurations/**",
      "**/*_generated.go",
    ]);
    expect(matches("applyconfigurations/core.go")).toBe(true);
    expect(matches("staging/client/applyconfigurations/core.go")).toBe(true);
    expect(matches("pkg/api/zz_generated.go")).toBe(true);
    expect(matches("pkg/api/not_generated.go.txt")).toBe(false);
    expect(generatedPathMatcher([])("pkg/api/zz_generated.go")).toBe(false);
  });

  test("confirms unique definition names but ignores ambiguity and constants", async () => {
    const index = SourceIndex.open();
    const embedder = new QueryEmbedder();
    try {
      await addEmbeddedFile(
        index,
        embedder,
        "src/base.ts",
        new Float32Array([0, 1]),
        "export class BaseCommand { execute() {} }\n",
      );
      const request = { query: "BaseCommand management behavior", maxResults: 5 };
      const disabled = await search(index, request, {
        embedder,
        uniqueSymbolMultiplier: 1,
      });
      const unique = await search(index, request, { embedder });
      expect(unique.results[0]!.score).toBeCloseTo(
        disabled.results[0]!.score * SEARCH_UNIQUE_SYMBOL_MULTIPLIER,
        8,
      );
      const exactDisabled = await search(index, request, {
        embedder,
        engine: "exact",
        uniqueSymbolMultiplier: 1,
      });
      const exactUnique = await search(index, request, {
        embedder,
        engine: "exact",
      });
      expect(exactUnique.results[0]!.score).toBeCloseTo(
        exactDisabled.results[0]!.score * SEARCH_UNIQUE_SYMBOL_MULTIPLIER,
        8,
      );

      await addEmbeddedFile(
        index,
        embedder,
        "src/other.ts",
        new Float32Array([0, 1]),
        "export class BaseCommand { run() {} }\n",
      );
      const ambiguous = await search(index, request, { embedder });
      const ambiguousDisabled = await search(index, request, {
        embedder,
        uniqueSymbolMultiplier: 1,
      });
      expect(ambiguous.results.map((result) => result.score)).toEqual(
        ambiguousDisabled.results.map((result) => result.score),
      );

      await addEmbeddedFile(
        index,
        embedder,
        "src/settings.ts",
        new Float32Array([0, 1]),
        "export const STATIC_URL = '/static/';\n",
      );
      const constantRequest = {
        query: "template behavior that uses STATIC_URL",
        maxResults: 5,
      };
      const constant = await search(index, constantRequest, { embedder });
      const constantDisabled = await search(index, constantRequest, {
        embedder,
        uniqueSymbolMultiplier: 1,
      });
      expect(constant.results.map((result) => result.score)).toEqual(
        constantDisabled.results.map((result) => result.score),
      );
    } finally {
      index.close();
    }
  });

  test("isolates path/name FTS from text-only and v1-like projections", async () => {
    const index = SourceIndex.open();
    const embedder = new QueryEmbedder();
    try {
      await index.indexFile(
        "special/needle.ts",
        "export function unrelated() { return true; }\n",
      );
      const current = await search(index, {
        query: "special needle",
        maxResults: 10,
      }, { embedder });
      expect(current.results.map((result) => result.path)).toEqual([
        "special/needle.ts",
      ]);
      expect(await search(index, {
        query: "special needle",
        maxResults: 10,
      }, { embedder, lexicalMode: "text-only" })).toMatchObject({
        results: [],
      });

      index.database.exec(
        "CREATE VIRTUAL TABLE temp.source_windows_fts_v1 USING fts5(text)",
      );
      index.database.exec(
        `INSERT INTO temp.source_windows_fts_v1(rowid, text)
         SELECT id, text FROM source_windows`,
      );
      const v1Like = await search(index, {
        query: "unrelated",
        maxResults: 10,
      }, { embedder, lexicalMode: "v1-like" });
      expect(v1Like.results[0]!.path).toBe("special/needle.ts");
      expect(v1Like.results[0]!.semanticScore).toBe(0);
    } finally {
      index.close();
    }
  });

  test("returns a reconciled lexical-only hit without embedding the query", async () => {
    const index = SourceIndex.open();
    const embedder = new QueryEmbedder();
    try {
      await index.indexFile(
        "active.ts",
        "export function lexicalOnlyHandler() { return true; }\n",
      );
      await index.indexFile(
        "stale.ts",
        "export function lexicalOnlyHandler() { return false; }\n",
      );
      expect(index.reconcileFiles(new Set(["active.ts"]))).toEqual(["stale.ts"]);
      const response = await search(index, {
        query: "lexical only handler",
        maxResults: 10,
      }, {
        embedder,
      });
      expect(response.results.map((result) => result.path)).toEqual([
        "active.ts",
      ]);
      expect(response.results[0]).toMatchObject({
        semanticScore: 0,
      });
      expect(response.results[0]!.lexicalScore).toBeGreaterThan(0);
      expect(response.diagnostics).toMatchObject({
        compatible: 0,
        missingEmbedding: 1,
        lexicalCandidates: 1,
      });
      expect(embedder.calls).toEqual([]);
    } finally {
      index.close();
    }
  });

  test("does not invoke scalar cosine while retrieving FTS candidates", async () => {
    const index = SourceIndex.open();
    const embedder = new QueryEmbedder();
    try {
      await addEmbeddedFile(
        index,
        embedder,
        "handler.ts",
        new Float32Array([1, 0]),
        "export function lexicalHandler() { return true; }\n",
      );
      const query = index.database.query.bind(index.database);
      Object.defineProperty(index.database, "query", {
        value: (sql: string) => {
          if (sql.includes("vec_distance_cosine")) {
            throw new Error("scalar cosine entered the query path");
          }
          return query(sql);
        },
      });
      const response = await search(index, {
        query: "lexical handler",
        maxResults: 1,
      }, { embedder });
      expect(response.results[0]!.path).toBe("handler.ts");
      expect(response.diagnostics.lexicalCandidates).toBe(1);
    } finally {
      index.close();
    }
  });

  test("keeps shared and semantic native candidate tuning independent", async () => {
    const index = SourceIndex.open();
    const embedder = new QueryEmbedder();
    try {
      await addEmbeddedFile(index, embedder, "main.ts", new Float32Array([1, 0]));
      const original = index.readNativeCandidates.bind(index);
      const limits: Array<{ shared: number; semantic?: number }> = [];
      index.readNativeCandidates = (...arguments_) => {
        limits.push({
          shared: arguments_[3],
          semantic: arguments_[4]?.semanticLimit,
        });
        return original(...arguments_);
      };
      await search(index, { query: "query", maxResults: 1 }, { embedder });
      await search(index, { query: "query", maxResults: 1 }, {
        embedder,
        candidateLimit: 17,
        semanticCandidateLimit: 42,
      });
      expect(limits).toEqual([
        {
          shared: SEARCH_CANDIDATE_LIMIT,
          semantic: SEARCH_SEMANTIC_CANDIDATE_LIMIT,
        },
        { shared: 17, semantic: 42 },
      ]);
    } finally {
      index.close();
    }
  });

  test("completes missing channel scores across the retrieved candidate union", async () => {
    const index = SourceIndex.open();
    const embedder = new QueryEmbedder();
    try {
      await addEmbeddedFile(
        index,
        embedder,
        "semantic.ts",
        new Float32Array([1, 0]),
        "export function semanticNeedle() { return 'needle'; }\n",
      );
      await addEmbeddedFile(
        index,
        embedder,
        "lexical.ts",
        new Float32Array([0, 1]),
        "needle needle needle needle needle\n",
      );

      const baseline = index.readNativeCandidates(
        embedder,
        new Float32Array([1, 0]),
        "needle",
        1,
        { semanticLimit: 1 },
      );
      expect(baseline.semantic.map((candidate) => candidate.path)).toEqual([
        "semantic.ts",
      ]);
      expect(baseline.lexical.map((candidate) => candidate.path)).toEqual([
        "lexical.ts",
      ]);

      const completed = index.readNativeCandidates(
        embedder,
        new Float32Array([1, 0]),
        "needle",
        1,
        { semanticLimit: 1, completeMissingScores: true },
      );
      expect(completed.semantic.map((candidate) => candidate.path)).toEqual([
        "semantic.ts",
        "lexical.ts",
      ]);
      expect(completed.lexical.map((candidate) => candidate.path)).toEqual([
        "lexical.ts",
        "semantic.ts",
      ]);
      expect(completed.semantic[1]!.semanticScore).toBe(0);
      expect(completed.lexical[1]!.lexicalScore).toBeGreaterThan(0);

      const baselineSearch = await search(index, {
        query: "needle",
        maxResults: 2,
      }, {
        embedder,
        candidateLimit: 1,
        semanticCandidateLimit: 1,
        semanticWeight: 0.5,
        completeMissingCandidateScores: false,
        candidateAggregation: "window",
      });
      const anchoredSearch = await search(index, {
        query: "needle",
        maxResults: 2,
      }, {
        embedder,
        candidateLimit: 1,
        semanticCandidateLimit: 1,
        semanticWeight: 0.5,
        completeMissingCandidateScores: true,
        candidateAggregation: "anchored-file",
        fileConfirmationWeight: 0.25,
        fileBonusCap: 0.1,
      });
      const anchoredByPath = new Map(
        anchoredSearch.results.map((hit) => [hit.path, hit.score]),
      );
      for (const hit of baselineSearch.results) {
        expect(anchoredByPath.get(hit.path)).toBeGreaterThanOrEqual(hit.score);
        expect(anchoredByPath.get(hit.path)).toBeLessThanOrEqual(hit.score * 1.1);
      }
    } finally {
      index.close();
    }
  });

  test("production search merges source chunks into one file with exact ranges", async () => {
    const index = SourceIndex.open();
    const embedder = new QueryEmbedder();
    try {
      await index.indexFile(
        "src/workflow.ts",
        "export function prepareWorkflow() {\n  return 'prepare';\n}\n\n" +
          "export function executeWorkflow() {\n  return 'execute';\n}\n",
      );
      const windows = index.loadWindows("src/workflow.ts");
      expect(windows.length).toBe(2);
      index.storeWindowEmbeddings(
        embedder,
        windows.map((window) => ({
          windowId: window.id,
          textHash: window.textHash,
          vector: new Float32Array([1, 0]),
        })),
      );

      const response = await search(index, {
        query: "prepareWorkflow executeWorkflow",
        maxResults: 10,
      }, { embedder });

      expect(response.results).toHaveLength(1);
      expect(response.results[0]!.path).toBe("src/workflow.ts");
      expect(response.results[0]!.windows).toEqual(
        windows.map((window) => ({
          id: window.id,
          startOffset: window.startOffset,
          endOffset: window.endOffset,
          startLine: window.startLine,
          endLine: window.endLine,
        })),
      );
      expect(response.results[0]!.sourceChunks).toEqual(
        windows.map((window) => ({
          id: window.sourceChunkId,
          kind: window.sourceChunk.kind,
          name: window.sourceChunk.name,
          startOffset: window.sourceChunk.startOffset,
          endOffset: window.sourceChunk.endOffset,
          startLine: window.sourceChunk.startLine,
          endLine: window.sourceChunk.endLine,
        })),
      );
      expect(response.results[0]!.score).toBeGreaterThan(
        response.results[0]!.semanticScore,
      );
    } finally {
      index.close();
    }
  });

  test("exact and native production search aggregate the same file ranges", async () => {
    const index = SourceIndex.open();
    const embedder = new QueryEmbedder();
    try {
      await index.indexFile(
        "src/workflow.ts",
        "export function prepareWorkflow() {\n  return 'prepare';\n}\n\n" +
          "export function executeWorkflow() {\n  return 'execute';\n}\n",
      );
      await index.indexFile(
        "src/other.ts",
        "export function otherWork() {\n  return 'other';\n}\n",
      );
      const workflow = index.loadWindows("src/workflow.ts");
      const other = index.loadWindows("src/other.ts")[0]!;
      expect(workflow.length).toBe(2);
      index.storeWindowEmbeddings(embedder, [
        ...workflow.map((window) => ({
          windowId: window.id,
          textHash: window.textHash,
          vector: new Float32Array([1, 0]),
        })),
        {
          windowId: other.id,
          textHash: other.textHash,
          vector: new Float32Array([0.8, 0.2]),
        },
      ]);
      const request = { query: "semantic intent", maxResults: 10 };

      const native = await search(index, request, {
        embedder,
        semanticWeight: 1,
      });
      const exact = await search(index, request, {
        embedder,
        engine: "exact",
        semanticWeight: 1,
      });

      expect(exact.results.map((result) => result.path)).toEqual(
        native.results.map((result) => result.path),
      );
      expect(exact.results.filter((result) =>
        result.path === "src/workflow.ts"
      )).toHaveLength(1);
      expect(exact.results[0]!.windows).toEqual(native.results[0]!.windows);
      expect(exact.results[0]!.sourceChunks).toEqual(
        native.results[0]!.sourceChunks,
      );
      expect(exact.results[0]!.score).toBeCloseTo(
        native.results[0]!.score,
        8,
      );
    } finally {
      index.close();
    }
  });

  test("keeps SQLite scalar ranking aligned with the exact reference", async () => {
    const index = SourceIndex.open();
    const embedder = new QueryEmbedder();
    try {
      await addEmbeddedFile(
        index,
        embedder,
        "src/alpha.ts",
        new Float32Array([1, 0]),
        "export function alphaHandler() { return handleAlpha(); }\n",
      );
      await addEmbeddedFile(
        index,
        embedder,
        "src/beta.ts",
        new Float32Array([1, 1]),
        "export function betaHandler() { return handleBeta(); }\n",
      );
      await addEmbeddedFile(
        index,
        embedder,
        "src/gamma.ts",
        new Float32Array([0, 1]),
        "export function gammaHandler() { return handleGamma(); }\n",
      );

      const request = { query: "alpha handler", maxResults: 3 };
      const native = await search(index, request, {
        embedder,
        semanticWeight: 1,
      });
      const exact = await search(index, request, {
        embedder,
        engine: "exact",
        semanticWeight: 1,
      });

      expect(native.results.map((result) => result.windowId)).toEqual(
        exact.results.map((result) => result.windowId),
      );
      for (let index = 0; index < native.results.length; index++) {
        expect(native.results[index]!.semanticScore).toBeCloseTo(
          exact.results[index]!.semanticScore,
          6,
        );
      }
      expect(native.diagnostics).toEqual(exact.diagnostics);
    } finally {
      index.close();
    }
  });

  test("skips zero-magnitude candidates after file reconciliation", async () => {
    const index = SourceIndex.open();
    const embedder = new QueryEmbedder();
    try {
      await addEmbeddedFile(index, embedder, "zero.ts", new Float32Array(2));
      await addEmbeddedFile(index, embedder, "active.ts", new Float32Array([1, 0]));
      await addEmbeddedFile(index, embedder, "stale.ts", new Float32Array([1, 0]));
      expect(index.reconcileFiles(new Set(["zero.ts", "active.ts"])))
        .toEqual(["stale.ts"]);

      const response = await search(index, { query: "active", maxResults: 20 }, {
        embedder,
      });
      expect(response.results.map((result) => result.path)).toEqual(["active.ts"]);
      expect(response.diagnostics).toMatchObject({
        total: 2,
        compatible: 2,
        unscorableCandidates: 1,
      });
    } finally {
      index.close();
    }
  });

  test("does not embed a query when there are no compatible candidates", async () => {
    const index = SourceIndex.open();
    const embedder = new QueryEmbedder();
    try {
      await index.indexFile("missing.ts", "export const missing = true;\n");
      const response = await search(index, { query: "anything", maxResults: 5 }, {
        embedder,
      });
      expect(response.results).toEqual([]);
      expect(response.diagnostics).toMatchObject({
        total: 1,
        compatible: 0,
        missingEmbedding: 1,
      });
      expect(embedder.calls).toEqual([]);
    } finally {
      index.close();
    }
  });

  test("validates requests and presentation before embedding", async () => {
    const index = SourceIndex.open();
    const embedder = new QueryEmbedder();
    try {
      await addEmbeddedFile(index, embedder, "main.ts", new Float32Array([1, 0]));
      for (const request of [
        { query: " ", maxResults: 1 },
        { query: "valid", maxResults: 0 },
        { query: "valid", maxResults: -1 },
        { query: "valid", maxResults: 1.5 },
        { query: "valid", maxResults: MAX_SEARCH_RESULTS + 1 },
      ]) {
        await expect(search(index, request, { embedder })).rejects.toThrow();
      }
      await expect(search(index, { query: "valid", maxResults: 1 }, {
        embedder,
        previewCharacters: 0,
      })).rejects.toThrow("maxCharacters must be a positive integer");
      for (const semanticWeight of [-0.1, 1.1, Number.NaN]) {
        await expect(search(index, { query: "valid", maxResults: 1 }, {
          embedder,
          semanticWeight,
        })).rejects.toThrow("semanticWeight must be between 0 and 1");
      }
      for (const [option, message] of [
        [{ candidateLimit: 0 }, "candidateLimit"],
        [{ semanticCandidateLimit: 0 }, "semanticCandidateLimit"],
        [{ candidateAggregation: "bogus" as "window" }, "candidateAggregation"],
        [{
          engine: "exact",
          candidateAggregation: "anchored-file",
        }, "exact search does not support anchored-file"],
        [{ fileConfirmationWeight: 2 }, "fileConfirmationWeight"],
        [{ fileBonusCap: -0.1 }, "fileBonusCap"],
        [{ exactNameMultiplier: 0 }, "exactNameMultiplier"],
        [{ uniqueSymbolMultiplier: Number.NaN }, "uniqueSymbolMultiplier"],
        [{ testPathMultiplier: -1 }, "testPathMultiplier"],
        [{ generatedPathMultiplier: 0 }, "generatedPathMultiplier"],
      ] as const) {
        await expect(search(index, { query: "valid", maxResults: 1 }, {
          embedder,
          ...option,
        })).rejects.toThrow(message);
      }
      expect(embedder.calls).toEqual([]);
    } finally {
      index.close();
    }
  });

  test("rejects malformed query embeddings", async () => {
    const index = SourceIndex.open();
    const validIdentity = new QueryEmbedder();
    try {
      await addEmbeddedFile(
        index,
        validIdentity,
        "main.ts",
        new Float32Array([1, 0]),
      );
      const cases: Array<[() => readonly Float32Array[], string]> = [
        [() => [], "returned 0 query vectors"],
        [() => [new Float32Array([1, 0]), new Float32Array([1, 0])],
          "returned 2 query vectors"],
        [() => [new Float32Array([1])], "has 1 dimensions"],
        [() => [new Float32Array([1, Number.NaN])], "non-finite"],
        [() => [new Float32Array(2)], "zero magnitude"],
      ];
      for (const [output, message] of cases) {
        await expect(search(index, { query: "query", maxResults: 1 }, {
          embedder: new QueryEmbedder(output),
        })).rejects.toThrow(message);
      }

      const wrongType = new QueryEmbedder(
        () => [new Float64Array([1, 0]) as unknown as Float32Array],
      );
      await expect(search(index, { query: "query", maxResults: 1 }, {
        embedder: wrongType,
      })).rejects.toThrow("not a Float32Array");
    } finally {
      index.close();
    }
  });

  test("rejects malformed embedder identities before inference", async () => {
    const index = SourceIndex.open();
    try {
      const blank = new QueryEmbedder();
      Object.defineProperty(blank, "model", { value: " " });
      await expect(search(index, { query: "query", maxResults: 1 }, {
        embedder: blank,
      })).rejects.toThrow("embedder model must not be empty");
      expect(blank.calls).toEqual([]);
    } finally {
      index.close();
    }
  });
});
