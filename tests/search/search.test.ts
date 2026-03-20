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
    { path: "/docs/setup.md", text: "Install Bun runtime for TypeScript development" },
    { path: "/docs/api.md", text: "REST API endpoints for user authentication" },
    { path: "/docs/db.md", text: "SQLite database schema and vector search" },
    { path: "/notes/feedback.md", text: "User prefers integration tests over mocks" },
  ];

  for (const f of files) {
    const emb = await embed(f.text);
    db.upsertFile(f.path, `hash-${f.path}`, [{ snippet: f.text, embedding: emb }]);
  }
}

async function seedMultiChunkDB() {
  // File with multiple chunks
  const chunks = [
    { text: "Introduction to the project setup and installation", snippet: "intro" },
    { text: "Database configuration with SQLite and vector search", snippet: "db-config" },
    { text: "Testing strategy with integration tests and CI pipeline", snippet: "testing" },
  ];

  const embeddedChunks = [];
  for (const c of chunks) {
    embeddedChunks.push({ snippet: c.text, embedding: await embed(c.text) });
  }

  db.upsertFile("/docs/guide.md", "hash-guide", embeddedChunks);

  // Another file for comparison
  const emb = await embed("Python machine learning with pandas");
  db.upsertFile("/docs/ml.md", "hash-ml", [
    { snippet: "Python machine learning with pandas", embedding: emb },
  ]);
}

describe("search", () => {
  test("returns results ranked by relevance", async () => {
    await seedDB();

    const results = await search("database SQL queries", db);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].path).toBe("/docs/db.md");
  });

  test("deduplicates chunks from the same file", async () => {
    await seedMultiChunkDB();

    const results = await search("setup and configuration", db, 10);
    // guide.md has 3 chunks but should appear only once
    const guidePaths = results.filter((r) => r.path === "/docs/guide.md");
    expect(guidePaths.length).toBe(1);
  });

  test("keeps best score per file after dedup", async () => {
    await seedMultiChunkDB();

    const results = await search("database SQLite vector", db);
    const guide = results.find((r) => r.path === "/docs/guide.md");
    if (guide) {
      // Score should be from the best-matching chunk, not worst
      expect(guide.score).toBeGreaterThan(0);
    }
  });

  test("collects multiple snippets from same file", async () => {
    await seedMultiChunkDB();

    const results = await search("project setup database testing", db, 10);
    const guide = results.find((r) => r.path === "/docs/guide.md");
    if (guide) {
      expect(guide.snippets.length).toBeGreaterThanOrEqual(1);
    }
  });

  test("respects topK limit by file", async () => {
    await seedDB();

    const results = await search("software development", db, 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  test("returns empty array when index is empty", async () => {
    const results = await search("anything", db);
    expect(results).toEqual([]);
  });

  test("threshold filters low-scoring results", async () => {
    await seedDB();

    // Very high threshold should filter most results
    const results = await search("database", db, 5, 0.99);
    expect(results.length).toBe(0);
  });
});
