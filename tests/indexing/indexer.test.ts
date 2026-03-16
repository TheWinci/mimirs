import { describe, test, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { indexDirectory } from "../../src/indexing/indexer";
import { RagDB } from "../../src/db";
import { getEmbedder } from "../../src/embeddings/embed";
import { createTempDir, cleanupTempDir, writeFixture } from "../helpers";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import type { RagConfig } from "../../src/config";

let tempDir: string;
let db: RagDB;

const defaultConfig: RagConfig = {
  include: ["**/*.md", "**/*.txt"],
  exclude: ["node_modules/**", ".git/**", ".rag/**"],
  chunkSize: 512,
  chunkOverlap: 50,
};

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

describe("indexDirectory", () => {
  test("indexes all files matching include patterns", async () => {
    await writeFixture(tempDir, "doc.md", "# Hello\n\nSome content here.");
    await writeFixture(tempDir, "notes.txt", "Plain notes.");

    const result = await indexDirectory(tempDir, db, defaultConfig);
    expect(result.indexed).toBe(2);
    expect(db.getStatus().totalFiles).toBe(2);
  });

  test("skips files matching exclude patterns", async () => {
    await writeFixture(tempDir, "doc.md", "# Keep me");
    await mkdir(join(tempDir, "node_modules"), { recursive: true });
    await writeFixture(tempDir, "node_modules/dep.md", "# Skip me");

    const result = await indexDirectory(tempDir, db, defaultConfig);
    expect(result.indexed).toBe(1);
  });

  test("skips unchanged files (same hash)", async () => {
    await writeFixture(tempDir, "doc.md", "# Stable content");

    const r1 = await indexDirectory(tempDir, db, defaultConfig);
    expect(r1.indexed).toBe(1);
    expect(r1.skipped).toBe(0);

    const r2 = await indexDirectory(tempDir, db, defaultConfig);
    expect(r2.indexed).toBe(0);
    expect(r2.skipped).toBe(1);
  });

  test("re-indexes changed files", async () => {
    await writeFixture(tempDir, "doc.md", "# Version 1");

    await indexDirectory(tempDir, db, defaultConfig);

    await writeFixture(tempDir, "doc.md", "# Version 2 with changes");

    const r2 = await indexDirectory(tempDir, db, defaultConfig);
    expect(r2.indexed).toBe(1);
    expect(r2.skipped).toBe(0);
  });

  test("prunes files deleted from disk", async () => {
    await writeFixture(tempDir, "keep.md", "# Keep");
    await writeFixture(tempDir, "delete.md", "# Delete");

    await indexDirectory(tempDir, db, defaultConfig);
    expect(db.getStatus().totalFiles).toBe(2);

    // Remove the file from disk
    const { unlink } = await import("fs/promises");
    await unlink(join(tempDir, "delete.md"));

    const r2 = await indexDirectory(tempDir, db, defaultConfig);
    expect(r2.pruned).toBe(1);
    expect(db.getStatus().totalFiles).toBe(1);
  });

  test("handles nested directories", async () => {
    await writeFixture(tempDir, "docs/guide.md", "# Guide");
    await writeFixture(tempDir, "docs/api/ref.md", "# API Reference");
    await writeFixture(tempDir, "notes.txt", "Notes");

    const result = await indexDirectory(tempDir, db, defaultConfig);
    expect(result.indexed).toBe(3);
  });

  test("reports correct indexed/skipped/pruned counts", async () => {
    await writeFixture(tempDir, "a.md", "# File A");
    await writeFixture(tempDir, "b.md", "# File B");

    // First index: 2 indexed
    const r1 = await indexDirectory(tempDir, db, defaultConfig);
    expect(r1.indexed).toBe(2);
    expect(r1.skipped).toBe(0);
    expect(r1.pruned).toBe(0);

    // Modify one, keep one
    await writeFixture(tempDir, "a.md", "# File A modified");

    const r2 = await indexDirectory(tempDir, db, defaultConfig);
    expect(r2.indexed).toBe(1);
    expect(r2.skipped).toBe(1);
    expect(r2.pruned).toBe(0);
  });

  test("calls onProgress callback during indexing", async () => {
    await writeFixture(tempDir, "doc.md", "# Content");

    const messages: string[] = [];
    await indexDirectory(tempDir, db, defaultConfig, (msg) =>
      messages.push(msg)
    );

    expect(messages.length).toBeGreaterThan(0);
    expect(messages.some((m) => m.includes("Found"))).toBe(true);
    expect(messages.some((m) => m.includes("Indexed"))).toBe(true);
  });

  test("skips empty files", async () => {
    await writeFixture(tempDir, "empty.md", "");
    await writeFixture(tempDir, "content.md", "# Has content");

    const result = await indexDirectory(tempDir, db, defaultConfig);
    expect(result.indexed).toBe(1);
    expect(result.skipped).toBe(1);
  });
});
