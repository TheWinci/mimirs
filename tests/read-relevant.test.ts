import { describe, test, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { searchChunks } from "../src/search";
import { RagDB } from "../src/db";
import { embed, getEmbedder } from "../src/embed";
import { createTempDir, cleanupTempDir } from "./helpers";

let tempDir: string;
let db: RagDB;

beforeAll(async () => {
  await getEmbedder();
});

beforeEach(async () => {
  tempDir = await createTempDir();
  db = new RagDB(tempDir);
});

afterEach(async () => {
  db.close();
  await cleanupTempDir(tempDir);
});

async function seedWithEntities() {
  // Simulate AST-chunked code file with entity metadata
  const chunks = [
    {
      text: "export function splitMarkdown(text: string): string[] {\n  const parts = text.split(/(?=^#{1,3}\\s)/m);\n  return parts.filter((p) => p.trim().length > 0);\n}",
      entityName: "splitMarkdown",
      chunkType: "function",
    },
    {
      text: "export function splitBySize(text: string, size: number, overlap: number): string[] {\n  const chunks: string[] = [];\n  let start = 0;\n  while (start < text.length) {\n    chunks.push(text.slice(start, start + size));\n    start += size - overlap;\n  }\n  return chunks;\n}",
      entityName: "splitBySize",
      chunkType: "function",
    },
    {
      text: "export async function chunkText(text: string, ext: string): Promise<string[]> {\n  if (ext === '.md') return splitMarkdown(text);\n  return splitBySize(text, 512, 50);\n}",
      entityName: "chunkText",
      chunkType: "function",
    },
  ];

  const embeddedChunks = [];
  for (const c of chunks) {
    embeddedChunks.push({
      snippet: c.text,
      embedding: await embed(c.text),
      entityName: c.entityName,
      chunkType: c.chunkType,
    });
  }
  db.upsertFile("/src/chunker.ts", "hash-chunker", embeddedChunks);

  // A second file with different content
  const dbChunks = [
    {
      text: "export class RagDB {\n  constructor(projectDir: string) {\n    this.db = new Database(join(projectDir, '.rag', 'index.db'));\n  }\n}",
      entityName: "RagDB",
      chunkType: "class",
    },
    {
      text: "export function openDatabase(path: string): Database {\n  return new Database(path);\n}",
      entityName: "openDatabase",
      chunkType: "function",
    },
  ];

  const embeddedDbChunks = [];
  for (const c of dbChunks) {
    embeddedDbChunks.push({
      snippet: c.text,
      embedding: await embed(c.text),
      entityName: c.entityName,
      chunkType: c.chunkType,
    });
  }
  db.upsertFile("/src/db.ts", "hash-db", embeddedDbChunks);
}

async function seedWithoutEntities() {
  // Simulate heuristic-chunked markdown (no entity metadata)
  const chunks = [
    { text: "## Installation\n\nRun `bun install` to install all dependencies." },
    { text: "## Configuration\n\nCreate a `.rag/config.json` file in your project root." },
  ];

  const embeddedChunks = [];
  for (const c of chunks) {
    embeddedChunks.push({
      snippet: c.text,
      embedding: await embed(c.text),
    });
  }
  db.upsertFile("/docs/setup.md", "hash-setup", embeddedChunks);
}

describe("searchChunks (read_relevant)", () => {
  test("returns individual chunks, not deduplicated by file", async () => {
    await seedWithEntities();

    const results = await searchChunks("splitting text into chunks", db, 10, 0);

    // Should be able to get multiple chunks from chunker.ts
    const chunkerResults = results.filter((r) => r.path === "/src/chunker.ts");
    expect(chunkerResults.length).toBeGreaterThanOrEqual(2);
  });

  test("returns full chunk content, not truncated", async () => {
    await seedWithEntities();

    const results = await searchChunks("markdown splitting", db, 5, 0);
    expect(results.length).toBeGreaterThan(0);

    // Content should be the full function text, not truncated
    const splitMd = results.find((r) => r.entityName === "splitMarkdown");
    if (splitMd) {
      expect(splitMd.content).toContain("export function splitMarkdown");
      expect(splitMd.content).toContain("return parts.filter");
    }
  });

  test("surfaces entity names from AST chunks", async () => {
    await seedWithEntities();

    const results = await searchChunks("database class constructor", db, 5, 0);
    const ragDbChunk = results.find((r) => r.entityName === "RagDB");
    expect(ragDbChunk).toBeDefined();
    expect(ragDbChunk!.chunkType).toBe("class");
  });

  test("entity is null for heuristic-split chunks", async () => {
    await seedWithoutEntities();

    const results = await searchChunks("installation setup", db, 5, 0);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entityName).toBeNull();
    expect(results[0].chunkType).toBeNull();
  });

  test("threshold filters low-scoring chunks", async () => {
    await seedWithEntities();

    // Very high threshold should filter everything
    const results = await searchChunks("markdown splitting", db, 5, 0.99);
    expect(results.length).toBe(0);
  });

  test("respects topK limit", async () => {
    await seedWithEntities();

    const results = await searchChunks("code", db, 2, 0);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  test("returns empty array when index is empty", async () => {
    const results = await searchChunks("anything", db, 8, 0);
    expect(results).toEqual([]);
  });

  test("chunks from different files can both appear", async () => {
    await seedWithEntities();

    const results = await searchChunks("database function export", db, 10, 0);

    const paths = new Set(results.map((r) => r.path));
    // Should have results from both files
    expect(paths.size).toBeGreaterThanOrEqual(2);
  });
});

describe("entity metadata in schema", () => {
  test("entity columns exist after migration on fresh DB", async () => {
    // The DB was just created in beforeEach — columns should exist
    const emb = await embed("test content");
    db.upsertFile("/test.ts", "hash-test", [
      { snippet: "test", embedding: emb, entityName: "testFn", chunkType: "function" },
    ]);

    // Verify we can search and get entity data back
    const results = db.searchChunks(emb, 1);
    expect(results.length).toBe(1);
    expect(results[0].entityName).toBe("testFn");
    expect(results[0].chunkType).toBe("function");
  });

  test("entity columns default to null when not provided", async () => {
    const emb = await embed("test content");
    db.upsertFile("/test.ts", "hash-test", [
      { snippet: "test", embedding: emb },
    ]);

    const results = db.searchChunks(emb, 1);
    expect(results.length).toBe(1);
    expect(results[0].entityName).toBeNull();
    expect(results[0].chunkType).toBeNull();
  });
});
