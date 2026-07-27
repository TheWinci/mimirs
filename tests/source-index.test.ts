import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chunk, textOf } from "@winci/bun-chunk";

import { renderSourceWindowTree } from "../src/cli/renderers/source-windows.ts";
import {
  SOURCE_EMBEDDING_DIRTY_GROUP_TABLE,
  SOURCE_INDEX_SCHEMA_VERSION,
  SOURCE_VECTOR_TABLE,
} from "../src/internals/storage/schema.ts";
import { configureSqliteRuntime } from
  "../src/internals/storage/sqlite-runtime.ts";
import {
  SourceIndex,
  SourceIndexSchemaMismatchError,
  SOURCE_INDEX_ANALYSIS_VERSION,
  sourceContentHash,
} from "../src/internals/storage/source-index.ts";

const FIXTURE =
  "tests/fixtures/source-windows/typescript/nested-class.ts";
const GOLDEN = join(
  import.meta.dir,
  "goldens",
  "source-windows",
  "typescript",
  "nested-class.windows.txt",
);

interface IdRow {
  id: number;
}

interface VersionRow {
  user_version: number;
}

interface CountRow {
  count: number;
}

interface JoinedRangeRow {
  path: string;
  parent_start_line: number;
  parent_end_line: number;
  window_start_line: number;
  window_end_line: number;
}

const temporaryDirectories: string[] = [];
const EMBEDDING_IDENTITY = {
  model: "test/model",
  revision: "1",
  variant: "test",
  dimensions: 4,
} as const;

configureSqliteRuntime();

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

async function fixtureSource(): Promise<string> {
  return Bun.file(join(import.meta.dir, "..", FIXTURE)).text();
}

function ids(
  index: SourceIndex,
  table: "source_chunks" | "source_facts" | "source_windows",
) {
  return index.database.query<IdRow, []>(
    `SELECT id FROM ${table} ORDER BY id`,
  ).all().map((row) => row.id);
}

describe("source index schema", () => {
  test("initializes once and enables foreign keys", () => {
    const database = new Database(":memory:", { strict: true });
    const first = new SourceIndex(database);
    const second = new SourceIndex(database);

    expect(database.query<VersionRow, []>("PRAGMA user_version").get())
      .toEqual({ user_version: SOURCE_INDEX_SCHEMA_VERSION });
    expect(database.query<{ foreign_keys: number }, []>(
      "PRAGMA foreign_keys",
    ).get()).toEqual({ foreign_keys: 1 });

    second.close();
    first.close();
  });

  test("rejects a database created by newer code", () => {
    const database = new Database(":memory:", { strict: true });
    database.exec(`PRAGMA user_version = ${SOURCE_INDEX_SCHEMA_VERSION + 1}`);
    expect(() => new SourceIndex(database)).toThrow(
      "newer than supported version",
    );
    database.close();
  });

  test("closes a read-only database after a schema mismatch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mimirs-read-only-schema-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "index.sqlite");
    const database = new Database(filename, { create: true, strict: true });
    const actual = SOURCE_INDEX_SCHEMA_VERSION - 1;
    database.exec(`PRAGMA user_version = ${actual}`);
    database.close();

    const close = spyOn(Database.prototype, "close");
    try {
      let thrown: unknown;
      try {
        SourceIndex.openReadOnly(filename);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(SourceIndexSchemaMismatchError);
      expect(thrown).toMatchObject({
        actual,
        expected: SOURCE_INDEX_SCHEMA_VERSION,
      });
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      close.mockRestore();
    }
  });

  test("migrates version one and refreshes its missing facts", async () => {
    const source = await fixtureSource();
    const database = new Database(":memory:", { strict: true });
    const original = new SourceIndex(database);
    const first = await original.indexFile(FIXTURE, source);
    database.exec("DROP TABLE source_facts");
    database.exec("UPDATE files SET analysis_version = 1");
    database.exec("PRAGMA user_version = 1");

    const upgraded = new SourceIndex(database);
    expect(database.query<{ name: string }, []>(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name = 'source_facts'`,
    ).get()).toEqual({ name: "source_facts" });
    expect(database.query<VersionRow, []>("PRAGMA user_version").get())
      .toEqual({ user_version: SOURCE_INDEX_SCHEMA_VERSION });
    const columns = database.query<{ name: string }, []>(
      "PRAGMA table_info(source_windows)",
    ).all().map((column) => column.name);
    expect(columns).not.toContain("embedding");
    expect(database.query<{ name: string }, []>(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name = 'source_vector_space'`,
    ).get()).toEqual({ name: "source_vector_space" });
    const refreshed = await upgraded.indexFile(FIXTURE, source);
    expect(refreshed.changed).toBe(true);
    expect(refreshed.file.id).toBe(first.file.id);
    expect(refreshed.file.analysisVersion).toBe(SOURCE_INDEX_ANALYSIS_VERSION);
    expect(refreshed.factCount).toBeGreaterThan(0);
    database.close();
  });

  test("migrates and backfills the FTS projection", async () => {
    const source = await fixtureSource();
    const database = new Database(":memory:", { strict: true });
    const original = new SourceIndex(database);
    await original.indexFile(FIXTURE, source);
    const windows = database.query<CountRow, []>(
      "SELECT count(*) AS count FROM source_windows",
    ).get()!.count;

    database.exec("DROP TABLE source_windows_fts");
    database.exec("PRAGMA user_version = 3");
    const upgraded = new SourceIndex(database);

    expect(database.query<CountRow, []>(
      "SELECT count(*) AS count FROM source_windows_fts",
    ).get()).toEqual({ count: windows });
    expect(database.query<CountRow, [string]>(
      `SELECT count(*) AS count
       FROM source_windows_fts
       WHERE source_windows_fts MATCH ?`,
    ).get('"session"')!.count).toBeGreaterThan(0);
    upgraded.close();
  });

  test("rebuilds an equal-size lexical projection after migration", async () => {
    const database = new Database(":memory:", { strict: true });
    const original = new SourceIndex(database);
    await original.indexFile(
      "legacy.ts",
      "export const beforetoken = true;\n",
    );
    database.exec(`
      UPDATE source_windows
      SET text = 'export const aftertoken = true;'
      WHERE id = (SELECT id FROM source_windows LIMIT 1);
      PRAGMA user_version = ${SOURCE_INDEX_SCHEMA_VERSION - 1};
    `);

    const upgraded = new SourceIndex(database);
    expect(database.query<CountRow, [string]>(
      `SELECT count(*) AS count
       FROM source_windows_fts
       WHERE source_windows_fts MATCH ?`,
    ).get('text : ("aftertoken")')).toEqual({ count: 1 });
    expect(database.query<CountRow, [string]>(
      `SELECT count(*) AS count
       FROM source_windows_fts
       WHERE source_windows_fts MATCH ?`,
    ).get('text : ("beforetoken")')).toEqual({ count: 0 });
    upgraded.close();
  });

  test("migrates inline v4 vectors into vec0 without retaining a copy", async () => {
    const database = new Database(":memory:", { strict: true });
    const original = new SourceIndex(database);
    await original.indexFile("legacy.ts", "export const legacy = true;\n");
    const window = original.loadWindows("legacy.ts")[0]!;
    for (const definition of [
      "embedding_model TEXT",
      "embedding_revision TEXT",
      "embedding_variant TEXT",
      "embedding_dimensions INTEGER",
      "embedding BLOB",
    ]) {
      database.exec(`ALTER TABLE source_windows ADD COLUMN ${definition}`);
    }
    const vector = new Float32Array([1, 2, 3, 4]);
    database.query(
      `UPDATE source_windows
       SET embedding_model = 'legacy/model', embedding_revision = '1',
           embedding_variant = 'test', embedding_dimensions = 4,
           embedding = ?
       WHERE id = ?`,
    ).run(new Uint8Array(vector.buffer), window.id);
    database.exec("DROP TABLE source_vector_space");
    database.exec("PRAGMA user_version = 4");

    const upgraded = new SourceIndex(database);
    const columns = database.query<{ name: string }, []>(
      "PRAGMA table_info(source_windows)",
    ).all().map((column) => column.name);
    expect(columns).not.toContain("embedding");
    expect(database.query<CountRow, []>(
      `SELECT count(*) AS count FROM ${SOURCE_VECTOR_TABLE}`,
    ).get()).toEqual({ count: 1 });
    const migrated = upgraded.loadWindows("legacy.ts")[0]!.embedding!;
    expect(migrated).toMatchObject({ dimensions: 4 });
    expect(Array.from(migrated.vector)).toEqual([1, 2, 3, 4]);
    upgraded.close();
  });

  test("migrates a legacy vec0 table to minimal vector storage", async () => {
    const database = new Database(":memory:", { strict: true });
    const original = new SourceIndex(database);
    await original.indexFile("legacy.ts", "export const legacy = true;\n");
    const window = original.loadWindows("legacy.ts")[0]!;
    database.exec(`
      DROP TABLE IF EXISTS ${SOURCE_VECTOR_TABLE};
      DELETE FROM source_vector_space;
      CREATE VIRTUAL TABLE ${SOURCE_VECTOR_TABLE} USING vec0(
        window_id INTEGER PRIMARY KEY,
        embedding float[4] distance_metric=cosine,
        model TEXT,
        revision TEXT,
        variant TEXT,
        path TEXT
      );
      INSERT INTO source_vector_space(id, dimensions) VALUES (1, 4);
    `);
    const vector = new Float32Array([4, 3, 2, 1]);
    database.query(
      `INSERT INTO ${SOURCE_VECTOR_TABLE}
         (window_id, embedding, model, revision, variant, path)
       VALUES (?, ?, 'legacy/model', '1', 'test', 'legacy.ts')`,
    ).run(window.id, new Uint8Array(vector.buffer));
    database.exec("PRAGMA user_version = 5");

    const upgraded = new SourceIndex(database);
    const columns = database.query<{ name: string }, []>(
      `PRAGMA table_info(${SOURCE_VECTOR_TABLE})`,
    ).all().map((column) => column.name);
    expect(columns).toEqual(["window_id", "embedding"]);
    expect(Array.from(
      upgraded.loadWindows("legacy.ts")[0]!.embedding!.vector,
    )).toEqual([4, 3, 2, 1]);
    upgraded.close();
  });

  test("migrates a v7 index with case-insensitive chunk-name lookup", () => {
    const database = new Database(":memory:", { strict: true });
    const original = new SourceIndex(database);
    database.exec("DROP INDEX source_chunks_name_nocase");
    database.exec("PRAGMA user_version = 7");

    const upgraded = new SourceIndex(database);
    expect(database.query<{ name: string }, []>(
      `SELECT name FROM sqlite_master
       WHERE type = 'index' AND name = 'source_chunks_name_nocase'`,
    ).get()).toEqual({ name: "source_chunks_name_nocase" });
    upgraded.close();
    original.close();
  });

  test("reconciles and drops the retired active-path projection from v8", async () => {
    const database = new Database(":memory:", { strict: true });
    const original = new SourceIndex(database);
    await original.indexFile("current.ts", "export const current = true;\n");
    await original.indexFile("stale.ts", "export const stale = true;\n");
    database.exec(`
      CREATE TABLE source_active_paths(path TEXT PRIMARY KEY);
      INSERT INTO source_active_paths(path) VALUES ('current.ts');
      PRAGMA user_version = 8;
    `);

    const upgraded = new SourceIndex(database);
    expect(upgraded.listFiles().map((file) => file.path)).toEqual(["current.ts"]);
    expect(upgraded.loadWindows("stale.ts")).toEqual([]);
    expect(database.query<{ count: number }, []>(
      "SELECT count(*) AS count FROM source_windows_fts",
    ).get()).toEqual({ count: 1 });
    expect(database.query<{ name: string }, []>(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name = 'source_active_paths'`,
    ).get()).toBeNull();
    upgraded.close();
    original.close();
  });
});

describe("source index persistence", () => {
  test("clears vector and input state when the embedding space changes", async () => {
    const index = SourceIndex.open();
    try {
      await index.indexFile("main.ts", "export const main = true;\n");
      const window = index.loadWindows("main.ts")[0]!;
      index.storeWindowEmbeddings(EMBEDDING_IDENTITY, [{
        windowId: window.id,
        textHash: window.textHash,
        vector: new Float32Array([1, 2, 3, 4]),
        baseInputHash: "base",
        effectiveInputHash: "effective",
        pathDisambiguated: false,
      }]);
      index.setEmbeddingInputPolicy("policy-v1");
      index.database.query(
        `INSERT INTO ${SOURCE_EMBEDDING_DIRTY_GROUP_TABLE}(base_input_hash)
         VALUES (?)`,
      ).run("base");

      const replacement = { ...EMBEDDING_IDENTITY, dimensions: 3 };
      index.prepareEmbeddingSpace(replacement);
      expect(index.embeddingDimensions()).toBe(3);
      expect(index.countSemanticVectors()).toBe(0);
      expect(index.countEmbeddingInputMetadata()).toBe(0);
      expect(index.embeddingInputPolicy()).toBeNull();
      expect(index.hasDirtyEmbeddingInputGroups()).toBe(false);

      index.storeWindowEmbeddings(replacement, [{
        windowId: window.id,
        textHash: window.textHash,
        vector: new Float32Array([1, 2, 3]),
        baseInputHash: "base-3",
        effectiveInputHash: "effective-3",
        pathDisambiguated: true,
      }]);
      index.setEmbeddingInputPolicy("policy-v2");
      index.database.query(
        `INSERT INTO ${SOURCE_EMBEDDING_DIRTY_GROUP_TABLE}(base_input_hash)
         VALUES (?)`,
      ).run("base-3");

      index.resetEmbeddingSpace(replacement);
      expect(index.embeddingDimensions()).toBe(3);
      expect(index.countSemanticVectors()).toBe(0);
      expect(index.countEmbeddingInputMetadata()).toBe(0);
      expect(index.embeddingInputPolicy()).toBeNull();
      expect(index.hasDirtyEmbeddingInputGroups()).toBe(false);
    } finally {
      index.close();
    }
  });

  test("recovers a missing vector table for the current space", async () => {
    const index = SourceIndex.open();
    try {
      await index.indexFile("main.ts", "export const main = true;\n");
      const window = index.loadWindows("main.ts")[0]!;
      const write = {
        windowId: window.id,
        textHash: window.textHash,
        vector: new Float32Array([1, 2, 3, 4]),
      };
      index.storeWindowEmbeddings(EMBEDDING_IDENTITY, [write]);
      index.database.exec(`DROP TABLE ${SOURCE_VECTOR_TABLE}`);

      index.prepareEmbeddingSpace(EMBEDDING_IDENTITY);
      expect(index.embeddingDimensions()).toBe(4);
      expect(index.database.query<{ present: number }, [string]>(
        `SELECT 1 AS present
         FROM sqlite_master
         WHERE type = 'table' AND name = ?`,
      ).get(SOURCE_VECTOR_TABLE)).toEqual({ present: 1 });
      expect(index.countSemanticVectors()).toBe(0);

      index.storeWindowEmbeddings(EMBEDDING_IDENTITY, [write]);
      expect(index.countSemanticVectors()).toBe(1);
    } finally {
      index.close();
    }
  });

  test("finds unique named chunks among reconciled files", async () => {
    const index = SourceIndex.open();
    try {
      await index.indexFile(
        "src/base.ts",
        "export class BaseCommand { execute() {} }\n",
      );
      expect(index.uniqueNamedSourceChunkIds(["basecommand"]).size).toBe(1);
      expect(index.uniqueNamedSourceChunkIds(["BaSeCoMmAnD"]).size).toBe(1);

      await index.indexFile(
        "vendor/base.ts",
        "export class BaseCommand { run() {} }\n",
      );
      expect(index.uniqueNamedSourceChunkIds(["BaseCommand"]).size).toBe(0);
      expect(index.reconcileFiles(new Set(["src/base.ts"]))).toEqual([
        "vendor/base.ts",
      ]);
      expect(index.uniqueNamedSourceChunkIds(["BaseCommand"]).size).toBe(1);
    } finally {
      index.close();
    }
  });

  test("round trips a reviewed window tree through SQL joins", async () => {
    const source = await fixtureSource();
    const index = SourceIndex.open();
    try {
      const result = await index.indexFile(FIXTURE, source, {
        targetCharacters: 180,
      });
      const parsed = await chunk(FIXTURE, source);
      const windows = index.loadWindows(FIXTURE);
      const golden = await Bun.file(GOLDEN).text();

      expect(result.changed).toBe(true);
      expect(result.file.analysisVersion).toBe(SOURCE_INDEX_ANALYSIS_VERSION);
      expect(result.file.windowTarget).toBe(180);
      expect(result.windowCount).toBe(windows.length);
      expect(result.factCount).toBe(parsed.facts.length);
      expect(index.loadFacts(FIXTURE)).toEqual(parsed.facts);
      expect(result.chunkCount).toBeGreaterThan(result.windowCount);
      expect(renderSourceWindowTree(FIXTURE, windows)).toBe(golden.trimEnd());
      expect(new Set(windows.map((window) => window.sourceChunkId)).size).toBe(1);
      expect(new Set(windows.map((window) => window.sourceChunk)).size).toBe(1);
      expect(textOf(windows[0]!.sourceChunk)).toBe(
        windows.map((window) => window.text).join(""),
      );

      const joined = index.database.query<JoinedRangeRow, [number]>(
        `SELECT
           f.path,
           c.start_line AS parent_start_line,
           c.end_line AS parent_end_line,
           w.start_line AS window_start_line,
           w.end_line AS window_end_line
         FROM source_windows w
         JOIN source_chunks c ON c.id = w.source_chunk_id
         JOIN files f ON f.id = c.file_id
         WHERE w.id = ?`,
      ).get(windows[0]!.id);
      expect(joined).toMatchObject({
        path: FIXTURE,
        parent_start_line: 1,
        parent_end_line: 31,
        window_start_line: 1,
      });
      expect(index.database.query<{ count: number }, []>(
        "SELECT count(*) AS count FROM source_chunks WHERE kind = 'gap'",
      ).get()).toEqual({ count: 0 });
    } finally {
      index.close();
    }
  });

  test("retains IDs for unchanged normalized content", async () => {
    const source = await fixtureSource();
    const index = SourceIndex.open();
    try {
      const first = await index.indexFile(FIXTURE, source, {
        targetCharacters: 180,
      });
      const chunkIds = ids(index, "source_chunks");
      const factIds = ids(index, "source_facts");
      const windowIds = ids(index, "source_windows");
      const equivalentSource = `\ufeff${source.replaceAll("\n", "\r\n")}`;
      const second = await index.indexFile(FIXTURE, equivalentSource, {
        targetCharacters: 180,
      });

      expect(sourceContentHash(source)).toBe(sourceContentHash(equivalentSource));
      expect(second.changed).toBe(false);
      expect(second.file.id).toBe(first.file.id);
      expect(second.file.contentHash).toBe(first.file.contentHash);
      expect(ids(index, "source_chunks")).toEqual(chunkIds);
      expect(ids(index, "source_facts")).toEqual(factIds);
      expect(ids(index, "source_windows")).toEqual(windowIds);
    } finally {
      index.close();
    }
  });

  test("keeps the file ID while atomically replacing changed analysis", async () => {
    const source = await fixtureSource();
    const index = SourceIndex.open();
    try {
      const first = await index.indexFile(FIXTURE, source, {
        targetCharacters: 180,
      });
      const changedSource = source +
        "\nexport function reportCount(values: Report[]): number {\n" +
        "  return values.length;\n}\n";
      const second = await index.indexFile(FIXTURE, changedSource, {
        targetCharacters: 180,
      });
      const windows = index.loadWindows(FIXTURE);

      expect(second.changed).toBe(true);
      expect(second.file.id).toBe(first.file.id);
      expect(second.file.contentHash).not.toBe(first.file.contentHash);
      expect(windows.at(-1)!.text).toContain("function reportCount");
      expect(index.database.query<CountRow, [string]>(
        `SELECT count(*) AS count
         FROM source_windows_fts
         WHERE source_windows_fts MATCH ?`,
      ).get('"report"')!.count).toBeGreaterThan(0);
      expect(index.database.query<{ count: number }, [number]>(
        "SELECT count(*) AS count FROM files WHERE id = ?",
      ).get(first.file.id)).toEqual({ count: 1 });
      expect(second.windowCount).toBe(windows.length);
    } finally {
      index.close();
    }
  });

  test("replaces windows when projection settings change", async () => {
    const source = await fixtureSource();
    const index = SourceIndex.open();
    try {
      const first = await index.indexFile(FIXTURE, source, {
        targetCharacters: 180,
      });
      const second = await index.indexFile(FIXTURE, source, {
        targetCharacters: 80,
      });

      expect(second.changed).toBe(true);
      expect(second.file.id).toBe(first.file.id);
      expect(second.file.contentHash).toBe(first.file.contentHash);
      expect(second.file.windowTarget).toBe(80);
      expect(second.windowCount).toBeGreaterThan(first.windowCount);
      await expect(index.indexFile(FIXTURE, source, {
        targetCharacters: 0,
      })).rejects.toThrow("targetCharacters must be a positive integer");
    } finally {
      index.close();
    }
  });

  test("persists across a file-backed database reopen", async () => {
    const source = await fixtureSource();
    const directory = await mkdtemp(join(tmpdir(), "mimirs-source-index-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "index.sqlite");

    const writer = SourceIndex.open(databasePath);
    await writer.indexFile(FIXTURE, source, { targetCharacters: 180 });
    writer.close();

    const reader = SourceIndex.open(databasePath);
    try {
      const windows = reader.loadWindows(FIXTURE);
      expect(windows.length).toBeGreaterThan(1);
      expect(reader.getFile(FIXTURE)?.contentHash).toBe(
        sourceContentHash(source),
      );
    } finally {
      reader.close();
    }
  });

  test("does not create a file row for binary input", async () => {
    const index = SourceIndex.open();
    try {
      await expect(index.indexFile("asset.bin", "before\0after")).rejects.toThrow(
        "cannot index binary source file",
      );
      expect(index.getFile("asset.bin")).toBeNull();
    } finally {
      index.close();
    }
  });
});
