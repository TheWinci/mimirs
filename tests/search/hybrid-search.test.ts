import { describe, test, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { search } from "../../src/search/hybrid";
import { RagDB } from "../../src/db";
import { embed, getEmbedder } from "../../src/embeddings/embed";
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

async function seedDB() {
  const files = [
    { path: "/src/auth.ts", text: "JWT authentication middleware with token validation and refresh" },
    { path: "/src/db.ts", text: "PostgreSQL database connection pool and query builder" },
    { path: "/docs/api.md", text: "REST API endpoints for user CRUD operations" },
    { path: "/src/utils.ts", text: "Helper functions: formatDate, parseJSON, slugify" },
  ];

  for (const f of files) {
    const emb = await embed(f.text);
    db.upsertFile(f.path, `hash-${f.path}`, [{ snippet: f.text, embedding: emb }]);
  }
}

describe("hybrid search", () => {
  test("vector-only search works (hybridWeight=1)", async () => {
    await seedDB();
    const results = await search("database connection", db, 5, 0, 1.0);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].path).toBe("/src/db.ts");
  });

  test("BM25 boosts exact keyword matches", async () => {
    await seedDB();
    // "slugify" is an exact term that BM25 should find easily
    const vectorOnly = await search("slugify", db, 5, 0, 1.0);
    const hybrid = await search("slugify", db, 5, 0, 0.5);

    // Both should find utils.ts, but hybrid should rank it with BM25 boost
    const vectorUtils = vectorOnly.find((r) => r.path === "/src/utils.ts");
    const hybridUtils = hybrid.find((r) => r.path === "/src/utils.ts");

    expect(hybridUtils).toBeDefined();
    if (vectorUtils && hybridUtils) {
      // Hybrid should give at least comparable score due to BM25 keyword match
      expect(hybridUtils.score).toBeGreaterThanOrEqual(vectorUtils.score * 0.8);
    }
  });

  test("BM25-only search works (hybridWeight=0)", async () => {
    await seedDB();
    const results = await search("PostgreSQL", db, 5, 0, 0.0);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].path).toBe("/src/db.ts");
  });

  test("default hybrid weight produces results", async () => {
    await seedDB();
    // Default hybridWeight (0.7)
    const results = await search("authentication JWT tokens", db);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].path).toBe("/src/auth.ts");
  });

  test("handles FTS special characters gracefully", async () => {
    await seedDB();
    // Characters that could break FTS5 query syntax
    const results = await search("(foo) AND bar OR baz*", db, 5, 0, 0.5);
    // Should not throw, may return empty
    expect(Array.isArray(results)).toBe(true);
  });

  test("text search on empty index returns empty", async () => {
    const results = db.textSearch("anything", 5);
    expect(results).toEqual([]);
  });
});
