import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Embedder } from
  "../src/internals/embeddings/embedder.ts";
import { embedSourceWindows } from
  "../src/internals/storage/source-embeddings.ts";
import {
  LABELED_SOURCE_NAME_PROJECTION,
  SOURCE_NAME_PROJECTION,
  SOURCE_PATH_PROJECTION,
  type SourceDocumentEmbedder,
  withDuplicatePathDisambiguation,
  withSourceEmbeddingProjection,
} from "../src/internals/storage/source-embeddings.ts";
import { SourceIndex } from
  "../src/internals/storage/source-index.ts";
import { SOURCE_EMBEDDING_INPUT_TABLE, SOURCE_VECTOR_TABLE } from
  "../src/internals/storage/schema.ts";

const FIXTURE = "tests/fixtures/source-windows/typescript/nested-class.ts";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

function deterministicVector(text: string, dimensions: number): Float32Array {
  let state = 2_166_136_261;
  for (let index = 0; index < text.length; index++) {
    state ^= text.charCodeAt(index);
    state = Math.imul(state, 16_777_619) >>> 0;
  }
  const vector = new Float32Array(dimensions);
  let norm = 0;
  for (let index = 0; index < dimensions; index++) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    vector[index] = state / 0xffff_ffff * 2 - 1;
    norm += vector[index]! * vector[index]!;
  }
  norm = Math.sqrt(norm);
  for (let index = 0; index < dimensions; index++) vector[index]! /= norm;
  return vector;
}

class RecordingEmbedder implements Embedder {
  readonly calls: string[][] = [];

  constructor(
    readonly model = "test/recording",
    readonly revision = "1",
    readonly variant = "deterministic",
    readonly dimensions = 4,
    readonly produce: (
      text: string,
      index: number,
    ) => Float32Array = (text) => deterministicVector(text, dimensions),
  ) {}

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    this.calls.push([...texts]);
    return texts.map((text, index) => this.produce(text, index));
  }
}

async function fixtureSource(): Promise<string> {
  return Bun.file(join(import.meta.dir, "..", FIXTURE)).text();
}

describe("source-window embeddings", () => {
  test("projects source names deterministically without changing anonymous text", () => {
    const named = {
      id: 1,
      path: "main.ts",
      text: "return execute();\n",
      textHash: "hash",
      sourceChunkKind: "function" as const,
      sourceChunkName: " run ",
    };
    expect(SOURCE_NAME_PROJECTION.project(named)).toBe(
      "run\nreturn execute();\n",
    );
    expect(LABELED_SOURCE_NAME_PROJECTION.project(named)).toBe(
      "Symbol: run\nreturn execute();\n",
    );
    expect(SOURCE_NAME_PROJECTION.project({
      ...named,
      sourceChunkName: null,
    })).toBe(named.text);
  });

  test("versions projected documents while leaving query inference raw", async () => {
    const index = SourceIndex.open();
    try {
      await index.indexFile("main.ts", "export function run() { return 1; }\n");
      const base = new RecordingEmbedder();
      const named = withSourceEmbeddingProjection(base, SOURCE_NAME_PROJECTION);
      const namedSummary = await embedSourceWindows(index, named);
      expect(base.calls.flat()).toEqual([
        "run\nexport function run() { return 1; }\n",
      ]);
      expect(index.loadWindows("main.ts")[0]!.embedding).not.toBeNull();

      base.calls.length = 0;
      await named.embed(["where is run"]);
      expect(base.calls).toEqual([["where is run"]]);

      const labeledBase = new RecordingEmbedder();
      const labeled = withSourceEmbeddingProjection(
        labeledBase,
        LABELED_SOURCE_NAME_PROJECTION,
      );
      expect(await embedSourceWindows(index, labeled, {
        previousIdentity: namedSummary,
      })).toMatchObject({
        total: 1,
        embedded: 1,
        unchanged: 0,
      });
      expect(labeledBase.calls.flat()).toEqual([
        "Symbol: run\nexport function run() { return 1; }\n",
      ]);
    } finally {
      index.close();
    }
  });

  test("uses path-average document inference while leaving query inference raw", async () => {
    const index = SourceIndex.open();
    try {
      const text = "export function alignSelected() { return true; }\n";
      await index.indexFile("packages/element/src/align.ts", text);
      const queryEmbedder = new RecordingEmbedder();
      const projected = withSourceEmbeddingProjection(
        queryEmbedder,
        SOURCE_PATH_PROJECTION,
      );
      const documentCalls: string[][] = [];
      const embedder: SourceDocumentEmbedder = {
        ...projected,
        variant: `${projected.variant}|test-average`,
        embedProjectedInputs: async (texts) => {
          documentCalls.push([...texts]);
          return texts.map((value) => deterministicVector(value, 4));
        },
      };
      const progress: Array<{ completed: number; total: number }> = [];

      const first = await embedSourceWindows(index, embedder, {
        onProgress: (value) => {
          progress.push(value);
        },
      });
      const expected = `File: packages/element/src/align.ts\n${text}`;
      expect(documentCalls).toEqual([[expected]]);
      expect(queryEmbedder.calls).toEqual([]);
      expect(Array.from(index.loadWindows("packages/element/src/align.ts")[0]!
        .embedding!.vector)).toEqual(
          Array.from(deterministicVector(expected, 4)),
        );
      expect(progress.at(-1)).toEqual({ completed: 1, total: 1 });

      documentCalls.length = 0;
      expect(await embedSourceWindows(index, embedder, {
        previousIdentity: first,
      })).toMatchObject({ embedded: 0, unchanged: 1 });
      expect(documentCalls).toEqual([]);

      await embedder.embed(["align selected elements"]);
      expect(queryEmbedder.calls).toEqual([["align selected elements"]]);
    } finally {
      index.close();
    }
  });

  test("path projection keeps identical text in different files distinct", async () => {
    const index = SourceIndex.open();
    try {
      const text = "export const duplicated = true;\n";
      await index.indexFile("a.ts", text);
      await index.indexFile("b.ts", text);
      const queryEmbedder = new RecordingEmbedder();
      const projected = withSourceEmbeddingProjection(
        queryEmbedder,
        SOURCE_PATH_PROJECTION,
      );
      const documentCalls: string[][] = [];
      const embedder: SourceDocumentEmbedder = {
        ...projected,
        variant: `${projected.variant}|test-average`,
        embedProjectedInputs: async (texts) => {
          documentCalls.push([...texts]);
          return texts.map((value) => deterministicVector(value, 4));
        },
      };

      await embedSourceWindows(index, embedder, {
        batchSize: 1,
        candidatePageSize: 1,
      });
      expect(documentCalls.flat()).toEqual([
        `File: a.ts\n${text}`,
        `File: b.ts\n${text}`,
      ]);
      expect(Array.from(index.loadWindows("a.ts")[0]!.embedding!.vector))
        .not.toEqual(
          Array.from(index.loadWindows("b.ts")[0]!.embedding!.vector),
        );
    } finally {
      index.close();
    }
  });

  test("embeds exact window text in deterministic batches and skips it later", async () => {
    const index = SourceIndex.open();
    try {
      await index.indexFile(FIXTURE, await fixtureSource(), {
        targetCharacters: 180,
      });
      const before = index.loadWindows(FIXTURE);
      expect(before.length).toBeGreaterThan(1);
      expect(before.every((window) => window.embedding === null)).toBe(true);

      const embedder = new RecordingEmbedder();
      const first = await embedSourceWindows(index, embedder, { batchSize: 2 });
      expect(index.database.query<{ name: string }, []>(
        `PRAGMA table_info(${SOURCE_VECTOR_TABLE})`,
      ).all().map((column) => column.name)).toEqual([
        "window_id",
        "embedding",
      ]);
      expect(first).toEqual({
        model: embedder.model,
        revision: embedder.revision,
        variant: embedder.variant,
        dimensions: embedder.dimensions,
        total: before.length,
        embedded: before.length,
        unchanged: 0,
        batches: Math.ceil(before.length / 2),
      });
      expect(embedder.calls.flat()).toEqual(before.map((window) => window.text));

      const after = index.loadWindows(FIXTURE);
      for (let position = 0; position < after.length; position++) {
        const embedding = after[position]!.embedding;
        expect(embedding).not.toBeNull();
        expect(embedding).toMatchObject({ dimensions: embedder.dimensions });
        expect(Array.from(embedding!.vector)).toEqual(
          Array.from(deterministicVector(after[position]!.text, embedder.dimensions)),
        );
      }

      const repeated = new RecordingEmbedder();
      expect(await embedSourceWindows(index, repeated, {
        previousIdentity: first,
      })).toMatchObject({
        total: before.length,
        embedded: 0,
        unchanged: before.length,
        batches: 0,
      });
      expect(repeated.calls).toEqual([]);
    } finally {
      index.close();
    }
  });

  test("infers duplicate raw inputs once across candidate pages and stores every vector", async () => {
    const index = SourceIndex.open();
    try {
      const text = "export const shared = true;\n";
      await index.indexFile("a.ts", text);
      await index.indexFile("b.ts", text);
      const progress: Array<{ completed: number; total: number }> = [];
      const embedder = new RecordingEmbedder();

      const summary = await embedSourceWindows(index, embedder, {
        batchSize: 1,
        candidatePageSize: 1,
        onProgress: (value) => {
          progress.push(value);
        },
      });

      expect(embedder.calls).toEqual([[text]]);
      expect(summary).toMatchObject({ total: 2, embedded: 2, unchanged: 0 });
      expect(index.loadWindows("a.ts")[0]!.embedding).not.toBeNull();
      expect(index.loadWindows("b.ts")[0]!.embedding).not.toBeNull();
      expect(progress.at(-1)).toEqual({ completed: 2, total: 2 });
      expect(progress.every((value) => value.completed <= value.total)).toBe(true);
    } finally {
      index.close();
    }
  });

  test("path-labels only exact projected inputs duplicated across paths", async () => {
    const index = SourceIndex.open();
    try {
      const shared = "export const shared = true;\n";
      const unique = "export const unique = true;\n";
      await index.indexFile("a.ts", shared);
      await index.indexFile("b.ts", shared);
      await index.indexFile("c.ts", unique);
      const base = new RecordingEmbedder();
      const embedder = withDuplicatePathDisambiguation(base);

      const progress: Array<{ completed: number; total: number }> = [];
      expect(await embedSourceWindows(index, embedder, {
        batchSize: 1,
        candidatePageSize: 1,
        onProgress: (value) => {
          progress.push(value);
        },
      })).toMatchObject({ total: 3, embedded: 3, unchanged: 0 });
      expect(base.calls.flat()).toEqual([
        `File: a.ts\n${shared}`,
        `File: b.ts\n${shared}`,
        unique,
      ]);
      expect(index.database.query<{
        path_disambiguated: number;
        count: number;
      }, []>(
        `SELECT path_disambiguated, count(*) AS count
         FROM ${SOURCE_EMBEDDING_INPUT_TABLE}
         GROUP BY path_disambiguated
         ORDER BY path_disambiguated`,
      ).all()).toEqual([
        { path_disambiguated: 0, count: 1 },
        { path_disambiguated: 1, count: 2 },
      ]);
      expect(progress.at(-1)).toEqual({ completed: 3, total: 3 });
    } finally {
      index.close();
    }
  });

  test("duplicate-path grouping uses the complete base name projection", async () => {
    const index = SourceIndex.open();
    try {
      const text = "export const shared = true;\n";
      await index.indexFile("a.ts", text);
      await index.indexFile("b.ts", text);
      index.database.query(
        `UPDATE source_chunks
         SET name = CASE (
           SELECT path FROM files WHERE files.id = source_chunks.file_id
         ) WHEN 'a.ts' THEN 'alpha' ELSE 'beta' END`,
      ).run();
      const base = new RecordingEmbedder();
      const embedder = withDuplicatePathDisambiguation(
        withSourceEmbeddingProjection(base, SOURCE_NAME_PROJECTION),
      );

      await embedSourceWindows(index, embedder, {
        batchSize: 1,
        candidatePageSize: 1,
      });
      expect(base.calls.flat()).toEqual([
        `alpha\n${text}`,
        `beta\n${text}`,
      ]);
      expect(base.calls.flat().every((input) => !input.startsWith("File:")))
        .toBe(true);
    } finally {
      index.close();
    }
  });

  test("reconciles persisted input policy changes without a prior manifest", async () => {
    const index = SourceIndex.open();
    try {
      const text = "export const shared = true;\n";
      await index.indexFile("a.ts", text);
      await index.indexFile("b.ts", text);
      const raw = new RecordingEmbedder();
      await embedSourceWindows(index, raw, {
        batchSize: 1,
        candidatePageSize: 1,
      });
      expect(raw.calls.flat()).toEqual([text]);

      const conditionalBase = new RecordingEmbedder();
      expect(await embedSourceWindows(
        index,
        withDuplicatePathDisambiguation(conditionalBase),
        { batchSize: 1, candidatePageSize: 1 },
      )).toMatchObject({ total: 2, embedded: 2, unchanged: 0 });
      expect(conditionalBase.calls.flat()).toEqual([
        `File: a.ts\n${text}`,
        `File: b.ts\n${text}`,
      ]);

      const reverted = new RecordingEmbedder();
      expect(await embedSourceWindows(index, reverted, {
        batchSize: 1,
        candidatePageSize: 1,
      })).toMatchObject({ total: 2, embedded: 2, unchanged: 0 });
      expect(reverted.calls.flat()).toEqual([text]);
    } finally {
      index.close();
    }
  });

  test("reconciles duplicate membership and resumes without repeating vectors", async () => {
    const index = SourceIndex.open();
    try {
      const text = "export const shared = true;\n";
      await index.indexFile("a.ts", text);
      const initialBase = new RecordingEmbedder();
      const initialEmbedder = withDuplicatePathDisambiguation(initialBase);
      const initial = await embedSourceWindows(index, initialEmbedder);
      expect(initialBase.calls.flat()).toEqual([text]);

      await index.indexFile("b.ts", text);
      const interruptedBase = new RecordingEmbedder();
      const interrupted = withDuplicatePathDisambiguation(interruptedBase);
      let calls = 0;
      const originalEmbed = interruptedBase.embed.bind(interruptedBase);
      interruptedBase.embed = async (texts) => {
        calls++;
        if (calls === 2) {
          interruptedBase.calls.push([...texts]);
          throw new Error("simulated duplicate transition interruption");
        }
        return originalEmbed(texts);
      };
      await expect(embedSourceWindows(index, interrupted, {
        batchSize: 1,
        candidatePageSize: 1,
        previousIdentity: initial,
      })).rejects.toThrow("simulated duplicate transition interruption");
      expect(interruptedBase.calls).toEqual([
        [`File: a.ts\n${text}`],
        [`File: b.ts\n${text}`],
      ]);

      const resumedBase = new RecordingEmbedder();
      const resumed = withDuplicatePathDisambiguation(resumedBase);
      const resumedSummary = await embedSourceWindows(index, resumed, {
        batchSize: 1,
        candidatePageSize: 1,
        previousIdentity: interrupted,
      });
      expect(resumedSummary).toMatchObject({
        total: 2,
        embedded: 1,
        unchanged: 1,
      });
      expect(resumedBase.calls.flat()).toEqual([`File: b.ts\n${text}`]);

      const unchangedBase = new RecordingEmbedder();
      expect(await embedSourceWindows(
        index,
        withDuplicatePathDisambiguation(unchangedBase),
        { previousIdentity: resumedSummary },
      )).toMatchObject({ total: 2, embedded: 0, unchanged: 2 });
      expect(unchangedBase.calls).toEqual([]);

      expect(index.reconcileFiles(new Set(["a.ts"]))).toEqual(["b.ts"]);
      const revertedBase = new RecordingEmbedder();
      expect(await embedSourceWindows(
        index,
        withDuplicatePathDisambiguation(revertedBase),
        { previousIdentity: resumedSummary },
      )).toMatchObject({ total: 1, embedded: 1, unchanged: 0 });
      expect(revertedBase.calls.flat()).toEqual([text]);
    } finally {
      index.close();
    }
  });

  for (const [label, projection] of [
    ["source-name", SOURCE_NAME_PROJECTION],
    ["labeled source-name", LABELED_SOURCE_NAME_PROJECTION],
  ] as const) {
    test(`deduplicates equal ${label} projected inputs`, async () => {
      const index = SourceIndex.open();
      try {
        const text = "export const shared = true;\n";
        await index.indexFile("a.ts", text);
        await index.indexFile("b.ts", text);
        const base = new RecordingEmbedder();
        await embedSourceWindows(
          index,
          withSourceEmbeddingProjection(base, projection),
          { batchSize: 1, candidatePageSize: 1 },
        );
        expect(base.calls).toHaveLength(1);
        expect(base.calls[0]).toHaveLength(1);
      } finally {
        index.close();
      }
    });

    test(`keeps identical raw text with different ${label} inputs distinct`, async () => {
      const index = SourceIndex.open();
      try {
        const text = "export const shared = true;\n";
        await index.indexFile("a.ts", text);
        await index.indexFile("b.ts", text);
        index.database.query(
          `UPDATE source_chunks
           SET name = CASE (
             SELECT path FROM files WHERE files.id = source_chunks.file_id
           ) WHEN 'a.ts' THEN 'alpha' ELSE 'beta' END`,
        ).run();
        const base = new RecordingEmbedder();
        await embedSourceWindows(
          index,
          withSourceEmbeddingProjection(base, projection),
          { batchSize: 2 },
        );
        expect(base.calls).toHaveLength(1);
        expect(base.calls[0]).toHaveLength(2);
        expect(new Set(base.calls[0]).size).toBe(2);
      } finally {
        index.close();
      }
    });
  }

  test("pages candidates without changing order or inference batches", async () => {
    const index = SourceIndex.open();
    try {
      const expected: string[] = [];
      for (const name of ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta"]) {
        const text = `export const ${name} = true;\n`;
        expected.push(text);
        await index.indexFile(`${name}.ts`, text);
      }
      expected.sort((left, right) => {
        const leftName = left.match(/const (\w+)/)![1]!;
        const rightName = right.match(/const (\w+)/)![1]!;
        return `${leftName}.ts`.localeCompare(`${rightName}.ts`);
      });

      const pageSizes: number[] = [];
      const readPage = index.readEmbeddingCandidatePage.bind(index);
      index.readEmbeddingCandidatePage = (...arguments_) => {
        const page = readPage(...arguments_);
        pageSizes.push(page.candidates.length);
        return page;
      };
      const embedder = new RecordingEmbedder();
      const summary = await embedSourceWindows(index, embedder, {
        batchSize: 2,
        candidatePageSize: 4,
      });

      expect(pageSizes).toEqual([4, 3, 4, 3]);
      expect(embedder.calls.map((batch) => batch.length)).toEqual([2, 2, 2, 1]);
      expect(embedder.calls.flat()).toEqual(expected);
      expect(summary).toMatchObject({ total: 7, embedded: 7, batches: 4 });
      expect(index.countEmbeddingCandidates(embedder)).toBe(0);
    } finally {
      index.close();
    }
  });

  test("requires candidate pages to preserve whole inference batches", async () => {
    const index = SourceIndex.open();
    try {
      await index.indexFile("main.ts", "export const main = true;\n");
      await expect(embedSourceWindows(index, new RecordingEmbedder(), {
        batchSize: 2,
        candidatePageSize: 3,
      })).rejects.toThrow(
        "candidatePageSize must be a positive multiple of batchSize",
      );
    } finally {
      index.close();
    }
  });

  test("regenerates changed windows and replaces a previous model in place", async () => {
    const index = SourceIndex.open();
    try {
      await index.indexFile("a.ts", "export const alpha = 1;\n");
      await index.indexFile("b.ts", "export const beta = 2;\n");
      const firstEmbedder = new RecordingEmbedder();
      const first = await embedSourceWindows(index, firstEmbedder);

      const betaBefore = index.loadWindows("b.ts")[0]!;
      await index.indexFile("a.ts", "export const alpha = 10;\n");
      expect(index.loadWindows("a.ts")[0]!.embedding).toBeNull();
      expect(index.loadWindows("b.ts")[0]!.embedding).not.toBeNull();

      const incremental = new RecordingEmbedder();
      const changed = await embedSourceWindows(index, incremental, {
        previousIdentity: first,
      });
      expect(changed).toMatchObject({ total: 2, embedded: 1, unchanged: 1 });
      expect(incremental.calls.flat()).toEqual(["export const alpha = 10;\n"]);
      expect(index.loadWindows("b.ts")[0]!.id).toBe(betaBefore.id);

      const replacement = new RecordingEmbedder(
        "test/replacement",
        "2",
        "other-space",
      );
      const replaced = await embedSourceWindows(index, replacement, {
        previousIdentity: changed,
      });
      expect(replaced).toMatchObject({ total: 2, embedded: 2, unchanged: 0 });
      expect(index.countWindows()).toBe(2);
      for (const path of ["a.ts", "b.ts"]) {
        expect(index.loadWindows(path)[0]!.embedding).not.toBeNull();
      }
    } finally {
      index.close();
    }
  });

  test("embeds and counts only files retained by reconciliation", async () => {
    const index = SourceIndex.open();
    try {
      await index.indexFile("current.ts", "export const current = true;\n");
      await index.indexFile("stale.ts", "export const stale = true;\n");
      const embedder = new RecordingEmbedder();

      const first = await embedSourceWindows(index, embedder);
      expect(first).toMatchObject({
        total: 2,
        embedded: 2,
        unchanged: 0,
      });
      expect(index.reconcileFiles(new Set(["current.ts"]))).toEqual(["stale.ts"]);
      expect(await embedSourceWindows(index, embedder, {
        previousIdentity: first,
      })).toMatchObject({
        total: 1,
        embedded: 0,
        unchanged: 1,
      });
      expect(embedder.calls.flat()).toEqual([
        "export const current = true;\n",
        "export const stale = true;\n",
      ]);
      expect(index.loadWindows("current.ts")[0]!.embedding).not.toBeNull();
      expect(index.getFile("stale.ts")).toBeNull();
      expect(index.loadWindows("stale.ts")).toEqual([]);
      expect(index.database.query<{ count: number }, []>(
        "SELECT count(*) AS count FROM source_windows_fts",
      ).get()).toEqual({ count: 1 });
      expect(index.database.query<{ count: number }, []>(
        `SELECT count(*) AS count FROM ${SOURCE_VECTOR_TABLE}`,
      ).get()).toEqual({ count: 1 });
    } finally {
      index.close();
    }
  });

  test("round trips vectors through a file-backed database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mimirs-embeddings-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "index.sqlite");
    const writer = SourceIndex.open(databasePath);
    await writer.indexFile("main.ts", "export function main() { return 1; }\n");
    const embedder = new RecordingEmbedder();
    await embedSourceWindows(writer, embedder);
    const expected = writer.loadWindows("main.ts")[0]!.embedding!;
    writer.close();

    const reader = SourceIndex.open(databasePath);
    try {
      const actual = reader.loadWindows("main.ts")[0]!.embedding!;
      expect(actual).toMatchObject({ dimensions: expected.dimensions });
      expect(Array.from(actual.vector)).toEqual(Array.from(expected.vector));
    } finally {
      reader.close();
    }
  });

  test("rotates the sole vec0 store when embedding dimensions change", async () => {
    const index = SourceIndex.open();
    try {
      await index.indexFile("main.ts", "export const main = true;\n");
      const first = await embedSourceWindows(index, new RecordingEmbedder());
      expect(index.loadWindows("main.ts")[0]!.embedding?.dimensions).toBe(4);

      const replacement = new RecordingEmbedder(
        "test/three-dimensional",
        "1",
        "replacement",
        3,
      );
      expect(await embedSourceWindows(index, replacement, {
        previousIdentity: first,
      })).toMatchObject({
        total: 1,
        embedded: 1,
        unchanged: 0,
        dimensions: 3,
      });
      const stored = index.loadWindows("main.ts")[0]!.embedding!;
      expect(stored).toMatchObject({ dimensions: 3 });
      expect(stored.vector).toHaveLength(3);
      expect(index.database.query<{ count: number }, []>(
        "SELECT count(*) AS count FROM source_window_vectors",
      ).get()).toEqual({ count: 1 });
    } finally {
      index.close();
    }
  });

  test("resumes after a later batch fails without repeating completed work", async () => {
    const index = SourceIndex.open();
    try {
      for (const [path, name] of [
        ["a.ts", "alpha"],
        ["b.ts", "beta"],
        ["c.ts", "gamma"],
      ] as const) {
        await index.indexFile(path, `export const ${name} = true;\n`);
      }

      const interrupted = new RecordingEmbedder();
      let call = 0;
      const originalEmbed = interrupted.embed.bind(interrupted);
      interrupted.embed = async (texts) => {
        call++;
        if (call === 2) {
          interrupted.calls.push([...texts]);
          throw new Error("simulated inference interruption");
        }
        return originalEmbed(texts);
      };

      await expect(embedSourceWindows(index, interrupted, { batchSize: 1 }))
        .rejects.toThrow("simulated inference interruption");
      expect(index.loadWindows("a.ts")[0]!.embedding).not.toBeNull();
      expect(index.loadWindows("b.ts")[0]!.embedding).toBeNull();
      expect(index.loadWindows("c.ts")[0]!.embedding).toBeNull();

      const resumed = new RecordingEmbedder();
      expect(await embedSourceWindows(index, resumed, {
        batchSize: 1,
        previousIdentity: interrupted,
      }))
        .toMatchObject({ total: 3, embedded: 2, unchanged: 1, batches: 2 });
      expect(resumed.calls.flat()).toEqual([
        "export const beta = true;\n",
        "export const gamma = true;\n",
      ]);
      expect(["a.ts", "b.ts", "c.ts"].every((path) =>
        index.loadWindows(path)[0]!.embedding !== null
      )).toBe(true);
    } finally {
      index.close();
    }
  });

  test("rejects a stale vector when its source window changes during inference", async () => {
    const index = SourceIndex.open();
    try {
      await index.indexFile("main.ts", "export const value = 'before';\n");
      const base = new RecordingEmbedder();
      const replacing: Embedder = {
        model: base.model,
        revision: base.revision,
        variant: base.variant,
        dimensions: base.dimensions,
        embed: async (texts) => {
          await index.indexFile("main.ts", "export const value = 'after';\n");
          return texts.map((text) => deterministicVector(text, base.dimensions));
        },
      };

      await expect(embedSourceWindows(index, replacing))
        .rejects.toThrow("changed while it was being embedded");
      const current = index.loadWindows("main.ts")[0]!;
      expect(current.text).toBe("export const value = 'after';\n");
      expect(current.embedding).toBeNull();
    } finally {
      index.close();
    }
  });

  test("rejects a malformed batch without writing any of its vectors", async () => {
    const index = SourceIndex.open();
    try {
      await index.indexFile(FIXTURE, await fixtureSource(), {
        targetCharacters: 180,
      });
      const malformed = new RecordingEmbedder(
        "test/malformed",
        "1",
        "wrong-dimension",
        4,
        (text, position) => position === 1
          ? new Float32Array(3)
          : deterministicVector(text, 4),
      );
      await expect(embedSourceWindows(index, malformed, { batchSize: 2 }))
        .rejects.toThrow("vector 1 has 3 dimensions; expected 4");
      expect(index.loadWindows(FIXTURE).every((window) =>
        window.embedding === null
      )).toBe(true);

      const nonFinite = new RecordingEmbedder(
        "test/non-finite",
        "1",
        "nan",
        4,
        () => new Float32Array([1, 2, Number.NaN, 4]),
      );
      await expect(embedSourceWindows(index, nonFinite))
        .rejects.toThrow("contains a non-finite value");
      expect(index.loadWindows(FIXTURE).every((window) =>
        window.embedding === null
      )).toBe(true);
    } finally {
      index.close();
    }
  });
});
