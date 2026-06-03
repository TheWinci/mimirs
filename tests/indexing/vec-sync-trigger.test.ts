import { describe, test, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { indexDirectory } from "../../src/indexing/indexer";
import { RagDB } from "../../src/db";
import { getEmbedder, DEFAULT_EMBEDDING_DIM } from "../../src/embeddings/embed";
import { createTempDir, cleanupTempDir, writeFixture } from "../helpers";
import type { RagConfig } from "../../src/config";
import { join } from "path";

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

function counts(d: RagDB) {
  const chunks = rawDb(d).query<{ n: number }, []>("SELECT COUNT(*) n FROM chunks").get()!.n;
  const vec = rawDb(d).query<{ n: number }, []>("SELECT COUNT(*) n FROM vec_chunks").get()!.n;
  const vecOrphans = rawDb(d)
    .query<{ n: number }, []>(
      "SELECT COUNT(*) n FROM vec_chunks WHERE chunk_id NOT IN (SELECT id FROM chunks)",
    )
    .get()!.n;
  return { chunks, vec, vecOrphans };
}

describe("chunks_vec_ad trigger keeps vec_chunks in sync", () => {
  test("deleting a chunk row drops its vec row via the trigger", async () => {
    await writeFixture(tempDir, "a.ts", `export function alpha() { return 1; }\n`);
    await indexDirectory(tempDir, db, tsConfig);

    const before = counts(db);
    expect(before.chunks).toBeGreaterThan(0);
    expect(before.vecOrphans).toBe(0);

    const someChunk = rawDb(db).query<{ id: number }, []>("SELECT id FROM chunks LIMIT 1").get()!;
    expect(
      rawDb(db).query<{ n: number }, [number]>("SELECT COUNT(*) n FROM vec_chunks WHERE chunk_id = ?").get(someChunk.id)!.n,
    ).toBe(1);

    rawDb(db).run("DELETE FROM chunks WHERE id = ?", [someChunk.id]);

    // Trigger should have removed the matching vector — no manual delete.
    expect(
      rawDb(db).query<{ n: number }, [number]>("SELECT COUNT(*) n FROM vec_chunks WHERE chunk_id = ?").get(someChunk.id)!.n,
    ).toBe(0);
    expect(counts(db).vecOrphans).toBe(0);
  });

  test("removeFile leaves zero vec rows for the removed file", async () => {
    await writeFixture(tempDir, "a.ts", `export function alpha() { return 1; }\n`);
    await indexDirectory(tempDir, db, tsConfig);

    expect(counts(db).chunks).toBeGreaterThan(0);

    const removed = db.removeFile(join(tempDir, "a.ts"));
    expect(removed).toBe(true);

    const after = counts(db);
    expect(after.chunks).toBe(0);
    expect(after.vec).toBe(0);
    expect(after.vecOrphans).toBe(0);
  });

  test("reindexing a changed file leaves no stale vec rows", async () => {
    await writeFixture(tempDir, "a.ts", `export function alpha() { return 1; }\n`);
    await indexDirectory(tempDir, db, tsConfig);
    expect(counts(db).vecOrphans).toBe(0);

    // Substantially change the file so chunks are replaced, then reindex.
    await writeFixture(
      tempDir,
      "a.ts",
      `export function beta() { return 2; }\nexport function gamma() { return 3; }\nexport const delta = 4;\n`,
    );
    await indexDirectory(tempDir, db, tsConfig);

    // The old chunks' vectors must be gone; no vec row may point at a missing chunk.
    expect(counts(db).vecOrphans).toBe(0);
  });
});

describe("conv_chunks_vec_ad trigger keeps vec_conversation in sync", () => {
  function convVecOrphans(d: RagDB): number {
    return rawDb(d)
      .query<{ n: number }, []>(
        "SELECT COUNT(*) n FROM vec_conversation WHERE chunk_id NOT IN (SELECT id FROM conversation_chunks)",
      )
      .get()!.n;
  }

  test("deleting a conversation chunk drops its vector (no orphan)", () => {
    const raw = rawDb(db);
    const blob = new Uint8Array(new Float32Array(DEFAULT_EMBEDDING_DIM).buffer);

    // FKs are off, so a chunk row can exist without a matching turn — that's the
    // exact scenario the trigger must cover (any future session/turn delete).
    raw.run("INSERT INTO conversation_chunks(turn_id, chunk_index, snippet) VALUES (1, 0, 'hello world')");
    const cid = raw.query<{ id: number }, []>("SELECT last_insert_rowid() AS id").get()!.id;
    raw.run("INSERT INTO vec_conversation(chunk_id, embedding) VALUES (?, ?)", [cid, blob]);

    expect(
      raw.query<{ n: number }, [number]>("SELECT COUNT(*) n FROM vec_conversation WHERE chunk_id = ?").get(cid)!.n,
    ).toBe(1);

    raw.run("DELETE FROM conversation_chunks WHERE id = ?", [cid]);

    expect(
      raw.query<{ n: number }, [number]>("SELECT COUNT(*) n FROM vec_conversation WHERE chunk_id = ?").get(cid)!.n,
    ).toBe(0);
    expect(convVecOrphans(db)).toBe(0);
  });
});
