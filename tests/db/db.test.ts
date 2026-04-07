import { describe, test, expect, beforeEach, afterEach, beforeAll } from "bun:test";
import { RagDB } from "../../src/db";
import { embed, getEmbedder } from "../../src/embeddings/embed";
import { createTempDir, cleanupTempDir } from "../helpers";
import { existsSync } from "fs";
import { join } from "path";

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

describe("RagDB", () => {
  test("creates .rag directory and index.db", () => {
    expect(existsSync(join(tempDir, ".mimirs"))).toBe(true);
    expect(existsSync(join(tempDir, ".mimirs", "index.db"))).toBe(true);
  });

  test("upsertFile stores file + chunks + vectors", async () => {
    const emb = await embed("test content");
    db.upsertFile("/test/file.md", "abc123", [
      { snippet: "test content", embedding: emb },
    ]);

    const status = db.getStatus();
    expect(status.totalFiles).toBe(1);
    expect(status.totalChunks).toBe(1);
  });

  test("upsertFile replaces existing file data", async () => {
    const emb1 = await embed("original content");
    db.upsertFile("/test/file.md", "hash1", [
      { snippet: "original content", embedding: emb1 },
    ]);

    const emb2 = await embed("updated content");
    db.upsertFile("/test/file.md", "hash2", [
      { snippet: "updated content", embedding: emb2 },
    ]);

    const status = db.getStatus();
    expect(status.totalFiles).toBe(1);
    expect(status.totalChunks).toBe(1);

    const file = db.getFileByPath("/test/file.md");
    expect(file!.hash).toBe("hash2");
  });

  test("getFileByPath returns stored file", async () => {
    const emb = await embed("content");
    db.upsertFile("/test/file.md", "abc", [
      { snippet: "content", embedding: emb },
    ]);

    const file = db.getFileByPath("/test/file.md");
    expect(file).not.toBeNull();
    expect(file!.path).toBe("/test/file.md");
    expect(file!.hash).toBe("abc");
  });

  test("getFileByPath returns null for unknown path", () => {
    const file = db.getFileByPath("/nonexistent");
    expect(file).toBeNull();
  });

  test("search returns results sorted by distance", async () => {
    const emb1 = await embed("TypeScript Bun runtime CLI tools");
    const emb2 = await embed("Python machine learning scikit-learn");
    const emb3 = await embed("JavaScript Bun fast bundler");

    db.upsertFile("/ts.md", "h1", [{ snippet: "TypeScript Bun", embedding: emb1 }]);
    db.upsertFile("/py.md", "h2", [{ snippet: "Python ML", embedding: emb2 }]);
    db.upsertFile("/js.md", "h3", [{ snippet: "JavaScript Bun", embedding: emb3 }]);

    const queryEmb = await embed("Bun JavaScript runtime");
    const results = db.search(queryEmb, 3);

    expect(results.length).toBe(3);
    // Results should be sorted by score descending (best first)
    expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
    expect(results[1].score).toBeGreaterThanOrEqual(results[2].score);
  });

  test("search respects topK limit", async () => {
    for (let i = 0; i < 10; i++) {
      const emb = await embed(`content ${i}`);
      db.upsertFile(`/file${i}.md`, `h${i}`, [
        { snippet: `content ${i}`, embedding: emb },
      ]);
    }

    const queryEmb = await embed("content");
    const results = db.search(queryEmb, 3);
    expect(results.length).toBe(3);
  });

  test("removeFile deletes file, chunks, and vectors", async () => {
    const emb = await embed("to be removed");
    db.upsertFile("/remove-me.md", "h1", [
      { snippet: "to be removed", embedding: emb },
    ]);

    expect(db.getStatus().totalFiles).toBe(1);

    const removed = db.removeFile("/remove-me.md");
    expect(removed).toBe(true);
    expect(db.getStatus().totalFiles).toBe(0);
    expect(db.getStatus().totalChunks).toBe(0);
  });

  test("removeFile returns false for unknown path", () => {
    const removed = db.removeFile("/nonexistent");
    expect(removed).toBe(false);
  });

  test("pruneDeleted removes files not in provided set", async () => {
    const emb1 = await embed("keep this");
    const emb2 = await embed("delete this");

    db.upsertFile("/keep.md", "h1", [{ snippet: "keep", embedding: emb1 }]);
    db.upsertFile("/delete.md", "h2", [{ snippet: "delete", embedding: emb2 }]);

    const pruned = db.pruneDeleted(new Set(["/keep.md"]));
    expect(pruned).toBe(1);
    expect(db.getStatus().totalFiles).toBe(1);
    expect(db.getFileByPath("/keep.md")).not.toBeNull();
    expect(db.getFileByPath("/delete.md")).toBeNull();
  });

  test("getStatus returns correct counts", async () => {
    const emb = await embed("multi chunk");
    db.upsertFile("/multi.md", "h1", [
      { snippet: "chunk 0", embedding: emb },
      { snippet: "chunk 1", embedding: emb },
      { snippet: "chunk 2", embedding: emb },
    ]);

    const status = db.getStatus();
    expect(status.totalFiles).toBe(1);
    expect(status.totalChunks).toBe(3);
    expect(status.lastIndexed).not.toBeNull();
  });

  test("getStatus returns null lastIndexed when empty", () => {
    const status = db.getStatus();
    expect(status.totalFiles).toBe(0);
    expect(status.totalChunks).toBe(0);
    expect(status.lastIndexed).toBeNull();
  });
});
