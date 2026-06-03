import { describe, test, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { indexDirectory } from "../../src/indexing/indexer";
import { RagDB } from "../../src/db";
import { getEmbedder } from "../../src/embeddings/embed";
import { createTempDir, cleanupTempDir, writeFixture } from "../helpers";
import type { RagConfig } from "../../src/config";

let tempDir: string;
let db: RagDB;

const tsConfig: RagConfig = {
  include: ["**/*.ts"],
  exclude: ["node_modules/**", ".git/**", ".mimirs/**"],
  chunkSize: 2048,
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

function rawDb(d: RagDB): import("bun:sqlite").Database {
  return (d as unknown as { db: import("bun:sqlite").Database }).db;
}

function chunkCount(d: RagDB): number {
  return rawDb(d).query<{ n: number }, []>("SELECT COUNT(*) n FROM chunks").get()!.n;
}

describe("B3: an interrupted index does not strand the file as 'unchanged'", () => {
  test("re-indexing after an abort picks the file back up", async () => {
    await writeFixture(tempDir, "a.ts", "export function alpha() { return 1; }\n");

    // Abort just as the file starts indexing — after the files row is created
    // (upsertFileStart) but before any chunks are written. This simulates a
    // crash/cancellation mid-index.
    const controller = new AbortController();
    const onProgress = (msg: string) => {
      if (msg.startsWith("Indexing ")) controller.abort();
    };
    await indexDirectory(tempDir, db, tsConfig, onProgress, controller.signal);

    // The interrupted file must not be left with a content hash + zero chunks.
    expect(chunkCount(db)).toBe(0);
    const fileRow = rawDb(db)
      .query<{ hash: string }, []>("SELECT hash FROM files LIMIT 1")
      .get();
    // Either no row, or an in-progress (empty) hash — never a real content hash.
    expect(fileRow?.hash ?? "").toBe("");

    // Re-index with no abort: the file must be indexed, not "Skipped (unchanged)".
    await indexDirectory(tempDir, db, tsConfig);
    expect(chunkCount(db)).toBeGreaterThan(0);
  });
});
