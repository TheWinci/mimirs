import { describe, test, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { searchChunks } from "../../src/search/hybrid";
import { RagDB } from "../../src/db";
import { embed, getEmbedder } from "../../src/embeddings/embed";
import { loadConfig } from "../../src/config";
import { createTempDir, cleanupTempDir } from "../helpers";

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

const QUERY = "rotation matrix transform helper";

/**
 * Seed a file with two leaf children (chunk_index >= 0) plus one synthetic parent
 * chunk (chunk_index === -1, a whole-class/file concatenation), all embedded to
 * match QUERY so they rank high. Mirrors what the indexer's createParentChunks
 * produces (parent rows live alongside leaf rows in the chunks table).
 */
async function seedWithParentRow() {
  const childA = {
    snippet: "export function rotationMatrix(a) { return build(a); }",
    embedding: await embed("rotation matrix function a"),
    entityName: "rotationMatrix",
    chunkType: "function",
    startLine: 10,
    endLine: 13,
  };
  const childB = {
    snippet: "export function matrixTranspose(m) { return flip(m); }",
    embedding: await embed("matrix transpose function b"),
    entityName: "matrixTranspose",
    chunkType: "function",
    startLine: 20,
    endLine: 23,
  };
  db.upsertFile("/src/matrix.ts", "hash-matrix", [childA, childB]);

  const file = db.getFileByPath("/src/matrix.ts");
  if (!file) throw new Error("seed file missing");
  // Parent chunk: chunk_index = -1, a large whole-file blob (what leaf-only drops).
  const parent = {
    snippet: "WHOLE FILE BLOB: rotation matrix transform helper module ".repeat(20),
    embedding: await embed(QUERY),
    entityName: "matrixModule",
    chunkType: "class",
    startLine: 1,
    endLine: 200,
  };
  db.insertChunkReturningId(file.id, parent, -1);
}

describe("searchChunks leaf-only", () => {
  test("leafOnly=true excludes parent chunks (chunk_index === -1)", async () => {
    await seedWithParentRow();
    const results = await searchChunks(QUERY, db, 10, 0, 0.5, [], undefined, 2, true);
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.chunkIndex !== -1)).toBe(true);
    // The leaf children should still be there.
    expect(results.some((r) => r.entityName === "rotationMatrix")).toBe(true);
  });

  test("leafOnly=false keeps the parent chunk (chunk_index === -1)", async () => {
    await seedWithParentRow();
    const results = await searchChunks(QUERY, db, 10, 0, 0.5, [], undefined, 2, false);
    expect(results.some((r) => r.chunkIndex === -1)).toBe(true);
  });

  test("leaf-only never drops leaf coverage vs default", async () => {
    await seedWithParentRow();
    const leaf = await searchChunks(QUERY, db, 10, 0, 0.5, [], undefined, 2, true);
    const full = await searchChunks(QUERY, db, 10, 0, 0.5, [], undefined, 2, false);
    const leafFiles = new Set(leaf.map((r) => r.path));
    const fullFiles = new Set(full.map((r) => r.path));
    // Every file surfaced by default is still surfaced leaf-only (children carry it).
    for (const f of fullFiles) expect(leafFiles.has(f)).toBe(true);
  });
});

describe("leaf-only config default", () => {
  test("leafOnly defaults to true", async () => {
    const config = await loadConfig(tempDir);
    expect(config.leafOnly).toBe(true);
  });
});
