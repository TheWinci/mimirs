import { describe, test, expect, beforeAll, afterEach } from "bun:test";
import { RagDB } from "../../src/db";
import { getEmbedder } from "../../src/embeddings/embed";
import { createTempDir, cleanupTempDir, writeFixture } from "../helpers";
import { indexDirectory } from "../../src/indexing/indexer";
import type { RagConfig } from "../../src/config";

const config: RagConfig = {
  include: ["**/*.ts"],
  exclude: ["node_modules/**", ".git/**", ".mimirs/**"],
  chunkSize: 512,
  chunkOverlap: 50,
  hybridWeight: 0.5,
  searchTopK: 5,
  benchmarkTopK: 5,
  benchmarkMinRecall: 0.8,
  benchmarkMinMrr: 0.6,
};

// Recreate the pre-`parts` schema (snippet-only FTS, no parts column) on an
// existing index, to exercise the in-place migration in RagDB's constructor.
const DOWNGRADE_SQL = `
  DROP TRIGGER IF EXISTS chunks_ai; DROP TRIGGER IF EXISTS chunks_ad; DROP TRIGGER IF EXISTS chunks_au;
  DROP TABLE IF EXISTS fts_chunks;
  CREATE VIRTUAL TABLE fts_chunks USING fts5(snippet, content='chunks', content_rowid='id');
  CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN INSERT INTO fts_chunks(rowid, snippet) VALUES (new.id, new.snippet); END;
  CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN INSERT INTO fts_chunks(fts_chunks, rowid, snippet) VALUES ('delete', old.id, old.snippet); END;
  CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN INSERT INTO fts_chunks(fts_chunks, rowid, snippet) VALUES ('delete', old.id, old.snippet); INSERT INTO fts_chunks(rowid, snippet) VALUES (new.id, new.snippet); END;
  INSERT INTO fts_chunks(fts_chunks) VALUES('rebuild');
  ALTER TABLE chunks DROP COLUMN parts;
`;

describe("FTS parts migration (old snippet-only index -> identifier-aware)", () => {
  let tempDir: string;
  beforeAll(async () => { await getEmbedder(); });
  afterEach(async () => { if (tempDir) await cleanupTempDir(tempDir); });

  test("migrates in place, preserves the index, and gains part matching", async () => {
    tempDir = await createTempDir();
    await writeFixture(tempDir, "graph.ts", "export function getDependsOn(id: number) { return resolveEdges(id); }\n");

    let db = new RagDB(tempDir);
    await indexDirectory(tempDir, db, config);
    const raw1 = (db as any).db;
    const chunkCount = (raw1.query("SELECT COUNT(*) n FROM chunks").get() as any).n;
    const vecCount = (raw1.query("SELECT COUNT(*) n FROM vec_chunks").get() as any).n;
    expect(chunkCount).toBeGreaterThan(0);

    // Downgrade to the old schema, then confirm the old FTS is blind to "depends".
    // Assert on db.textSearch (raw FTS), not search() — search()'s vector
    // candidates would find graph.ts semantically and mask the FTS behaviour.
    raw1.exec(DOWNGRADE_SQL);
    expect(db.textSearch("depends", 20).some((r) => r.path.includes("graph.ts"))).toBe(false);
    db.close();

    // Reopen -> migration runs in the constructor.
    db = new RagDB(tempDir);
    const raw2 = (db as any).db;

    // Index integrity preserved (no chunks/vectors lost).
    expect((raw2.query("SELECT COUNT(*) n FROM chunks").get() as any).n).toBe(chunkCount);
    expect((raw2.query("SELECT COUNT(*) n FROM vec_chunks").get() as any).n).toBe(vecCount);

    // New capability: a word-part now matches the compound identifier via FTS.
    expect(db.textSearch("depends", 20).some((r) => r.path.includes("graph.ts"))).toBe(true);
    db.close();
  });
});
