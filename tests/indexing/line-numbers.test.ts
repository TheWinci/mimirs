import { describe, test, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { indexDirectory, indexFile } from "../../src/indexing/indexer";
import { RagDB } from "../../src/db";
import { getEmbedder } from "../../src/embeddings/embed";
import { createTempDir, cleanupTempDir, writeFixture } from "../helpers";
import type { RagConfig } from "../../src/config";

let tempDir: string;
let db: RagDB;

const tsConfig: RagConfig = {
  include: ["**/*.ts"],
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

describe("line numbers in indexed chunks", () => {
  test("start_line and end_line are non-null after indexing a TS file", async () => {
    await writeFixture(
      tempDir,
      "example.ts",
      `export function hello(): string {
  return "hello";
}

export function world(): string {
  return "world";
}
`
    );

    await indexDirectory(tempDir, db, tsConfig);

    const emb = (await import("../../src/embeddings/embed")).embed;
    const queryEmb = await emb("hello function");
    const results = db.searchChunks(queryEmb, 5);

    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.startLine).not.toBeNull();
      expect(r.endLine).not.toBeNull();
      expect(r.startLine).toBeGreaterThanOrEqual(1);
      expect(r.endLine).toBeGreaterThanOrEqual(r.startLine!);
    }
  });

  test("line range for first function starts near line 1", async () => {
    await writeFixture(
      tempDir,
      "fn.ts",
      `export function first(): void {
  console.log("first");
}

export function second(): void {
  console.log("second");
}
`
    );

    await indexDirectory(tempDir, db, tsConfig);

    const emb = (await import("../../src/embeddings/embed")).embed;
    const queryEmb = await emb("first function console log");
    const results = db.searchChunks(queryEmb, 10);

    const firstFnChunk = results.find(
      (r) => r.entityName === "first" || (r.content && r.content.includes("first"))
    );
    expect(firstFnChunk).toBeDefined();
    expect(firstFnChunk!.startLine).toBe(1);
  });

  test("chunks without line numbers stored degrade gracefully", async () => {
    // Seed a chunk with no line numbers directly — simulates old rows
    const { embed } = await import("../../src/embeddings/embed");
    const emb = await embed("some content without lines");
    db.upsertFile("/old-file.ts", "hash-old", [
      { snippet: "some content without lines", embedding: emb, startLine: null, endLine: null },
    ]);

    const results = db.searchChunks(emb, 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].startLine).toBeNull();
    expect(results[0].endLine).toBeNull();
  });

  test("line numbers survive a re-index", async () => {
    await writeFixture(
      tempDir,
      "stable.ts",
      `export function stable(): boolean {
  return true;
}
`
    );

    // Index once
    await indexDirectory(tempDir, db, tsConfig);

    const { embed } = await import("../../src/embeddings/embed");
    const queryEmb = await embed("stable function");
    const first = db.searchChunks(queryEmb, 5);
    const firstLine = first[0]?.startLine;
    expect(firstLine).not.toBeNull();

    // Force re-index by removing the file record (simulating content change)
    // Change file hash so it re-indexes
    await writeFixture(
      tempDir,
      "stable.ts",
      `// updated comment
export function stable(): boolean {
  return true;
}
`
    );
    await indexDirectory(tempDir, db, tsConfig);

    const second = db.searchChunks(queryEmb, 5);
    expect(second[0]?.startLine).not.toBeNull();
  });
});
