import { describe, test, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { RagDB } from "../../src/db";
import { search } from "../../src/search/hybrid";
import { indexDirectory } from "../../src/indexing/indexer";
import { embed, getEmbedder } from "../../src/embeddings/embed";
import { createTempDir, cleanupTempDir, writeFixture } from "../helpers";
import type { RagConfig } from "../../src/config";

// Part 2 #4: every feature suite reads back through the SAME open handle, so the
// product's core promise ("future sessions see this") was never tested for
// durability. These write, CLOSE, reopen a fresh RagDB, and read back — also
// re-running initSchema + migrations against populated data.

let tempDir: string;

const config: RagConfig = {
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
});

afterEach(async () => {
  await cleanupTempDir(tempDir);
});

describe("data survives closing and reopening the index", () => {
  test("a checkpoint round-trips and stays vector-searchable", async () => {
    const emb = await embed("chose RRF fusion over linear blending for hybrid search");

    const db1 = new RagDB(tempDir);
    const id = db1.createCheckpoint(
      "sess-1", 0, "2026-01-01T00:00:00Z", "decision",
      "Chose RRF fusion", "Switched hybrid search to reciprocal-rank fusion.",
      ["src/search/hybrid.ts"], ["search", "rrf"], emb,
    );
    db1.close();

    const db2 = new RagDB(tempDir);
    const cp = db2.getCheckpoint(id);
    expect(cp).not.toBeNull();
    expect(cp!.title).toBe("Chose RRF fusion");
    expect(cp!.summary).toContain("reciprocal-rank");

    const found = db2.searchCheckpoints(await embed("hybrid ranking decision"), 5);
    expect(found.some((c) => c.id === id)).toBe(true);
    db2.close();
  });

  test("an annotation round-trips and stays vector-searchable", async () => {
    const emb = await embed("RagDB constructor applies embedding config before initSchema");

    const db1 = new RagDB(tempDir);
    const id = db1.upsertAnnotation("src/db/index.ts", "Constructor order matters: config before schema", emb, "RagDB", "agent");
    db1.close();

    const db2 = new RagDB(tempDir);
    const notes = db2.getAnnotations("src/db/index.ts", "RagDB");
    expect(notes.length).toBe(1);
    expect(notes[0].note).toContain("Constructor order");

    const found = db2.searchAnnotations(await embed("embedding config initialization order"), 5);
    expect(found.some((a) => a.id === id)).toBe(true);
    db2.close();
  });

  test("indexed chunks survive a reopen and remain searchable", async () => {
    await writeFixture(tempDir, "auth.ts", "export function verifyJwt(token: string) { return token.length > 0; }\n");

    const db1 = new RagDB(tempDir);
    await indexDirectory(tempDir, db1, config);
    const before = (db1 as unknown as { db: import("bun:sqlite").Database }).db
      .query<{ n: number }, []>("SELECT COUNT(*) n FROM chunks").get()!.n;
    expect(before).toBeGreaterThan(0);
    db1.close();

    const db2 = new RagDB(tempDir);
    const after = (db2 as unknown as { db: import("bun:sqlite").Database }).db
      .query<{ n: number }, []>("SELECT COUNT(*) n FROM chunks").get()!.n;
    expect(after).toBe(before); // no chunk lost or duplicated on reopen

    const results = await search("verify jwt token", db2, 5);
    expect(results.some((r) => r.path.endsWith("auth.ts"))).toBe(true);
    db2.close();
  });
});
