import { describe, test, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { searchChunks } from "../../src/search/hybrid";
import { RagDB } from "../../src/db";
import { embed, getEmbedder } from "../../src/embeddings/embed";
import { loadConfig } from "../../src/config";
import { createTempDir, cleanupTempDir } from "../helpers";

let tempDir: string;
let db: RagDB;

beforeAll(async () => { await getEmbedder(); });
beforeEach(async () => { tempDir = await createTempDir(); db = new RagDB(tempDir); });
afterEach(async () => { db.close(); await cleanupTempDir(tempDir); });

const QUERY = "rotation matrix transform helper";

// Seed several leaf chunks with a spread of relevance to QUERY so the ranked list
// has a head and a weak tail (for the relative-cutoff to bite).
async function seedSpread() {
  const mk = async (text: string, name: string, start: number) => ({
    snippet: text, embedding: await embed(text), entityName: name,
    chunkType: "function", startLine: start, endLine: start + 3,
  });
  db.upsertFile("/src/a.ts", "ha", [
    await mk("rotation matrix transform helper compute", "rotMatrix", 10),
    await mk("matrix transform rotate helper apply", "applyRot", 20),
  ]);
  db.upsertFile("/src/b.ts", "hb", [
    await mk("totally unrelated networking socket buffer", "sock", 10),
    await mk("database migration schema version", "migrate", 20),
  ]);
}

describe("chunk re-rank config knobs", () => {
  test("config defaults are the measured peak", async () => {
    const cfg = await loadConfig(tempDir);
    expect(cfg.chunkParentBoost).toBe(0.3);
    expect(cfg.chunkRelCutoff).toBe(0.85);
    expect(cfg.chunkSteepSkip).toBe(0.15);
  });

  test("relCutoff trims the weak tail (never grows the result set)", async () => {
    await seedSpread();
    const noCut = await searchChunks(QUERY, db, 10, 0, 0.5, [], undefined, 2, true, false, 0, 0);
    const cut = await searchChunks(QUERY, db, 10, 0, 0.5, [], undefined, 2, true, false, 0, 0.85, 0.15);
    expect(cut.length).toBeLessThanOrEqual(noCut.length);
    // The strongest chunk always survives the cut.
    expect(cut[0].path).toBe(noCut[0].path);
  });

  test("relCutoff=0 disables the cut (full set returned)", async () => {
    await seedSpread();
    const a = await searchChunks(QUERY, db, 10, 0, 0.5, [], undefined, 2, true, false, 0, 0);
    const b = await searchChunks(QUERY, db, 10, 0, 0.5, [], undefined, 2, true, false, 0, 0, 0.15);
    expect(b.length).toBe(a.length);
  });

  test("parentBoost runs without error and keeps the top hit", async () => {
    await seedSpread();
    const base = await searchChunks(QUERY, db, 10, 0, 0.5, [], undefined, 2, true);
    const boosted = await searchChunks(QUERY, db, 10, 0, 0.5, [], undefined, 2, true, false, 0.3, 0, 0.15);
    expect(boosted.length).toBeGreaterThan(0);
    expect(boosted.some((r) => r.entityName === "rotMatrix")).toBe(true);
    expect(base.length).toBeGreaterThan(0);
  });
});
