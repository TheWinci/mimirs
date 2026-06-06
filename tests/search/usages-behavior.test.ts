import { describe, test, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { indexDirectory } from "../../src/indexing/indexer";
import { RagDB } from "../../src/db";
import { getEmbedder } from "../../src/embeddings/embed";
import { createTempDir, cleanupTempDir, writeFixture } from "../helpers";
import type { RagConfig } from "../../src/config";

// B6: pin the behavior of `usages`/findUsages so the tool description stays
// honest. Aliased call sites are now RESOLVED (bun-chunk records the original
// name in ChunkImport.imported; mimirs resolves the alias ref to the real
// export). One known non-precision remains: results can include matches inside
// comments (the FTS fallback isn't AST-precise), so usages is not a pure
// call-graph query.

let tempDir: string;
let db: RagDB;

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
  db = new RagDB(tempDir);
});

afterEach(async () => {
  db.close();
  await cleanupTempDir(tempDir);
});

async function seed() {
  await writeFixture(tempDir, "db.ts", `export function getDB(p: string) { return { p }; }\n`);
  await writeFixture(
    tempDir,
    "alias.ts",
    `import { getDB as g } from "./db";\nexport function useIt() {\n  return g("x");\n}\n`,
  );
  await writeFixture(tempDir, "direct.ts", `import { getDB } from "./db";\nexport function plain() {\n  return getDB("y");\n}\n`);
  await writeFixture(
    tempDir,
    "comment.ts",
    `// getDB is the canonical accessor; do not call getDB here.\nexport const note = 1;\n`,
  );
  await indexDirectory(tempDir, db, config);
}

describe("usages behavior (pinned)", () => {
  test("finds a direct call site of the searched name", async () => {
    await seed();
    const results = db.findUsages("getDB", true, 30);
    expect(
      results.some((r) => r.path.endsWith("direct.ts") && r.snippet.includes("getDB(")),
    ).toBe(true);
  });

  test("FINDS an aliased call site when searching the original name", async () => {
    await seed();
    const results = db.findUsages("getDB", true, 30);
    // The actual call is `g("x")` in alias.ts (import { getDB as g }). The alias
    // ref resolves to getDB's export, so searching "getDB" surfaces it.
    const aliasCall = results.some((r) => r.path.endsWith("alias.ts") && r.snippet.includes('g("x")'));
    expect(aliasCall).toBe(true);
    // Searching the alias name itself still finds it too.
    expect(db.findUsages("g", true, 30).some((r) => r.path.endsWith("alias.ts"))).toBe(true);
  });

  test("caps at top, and top+1 reveals more exist (truncation signal)", async () => {
    await seed();
    const all = db.findUsages("getDB", true, 30);
    expect(all.length).toBeGreaterThanOrEqual(2); // several call sites of getDB

    // findUsages caps at the requested top.
    expect(db.findUsages("getDB", true, 1).length).toBe(1);

    // The usages tool's idiom: fetch limit+1 — length > limit means "more exist",
    // which the tool surfaces instead of presenting a capped set as complete.
    const limit = 1;
    const raw = db.findUsages("getDB", true, limit + 1);
    expect(raw.length).toBe(2);
    expect(raw.length > limit).toBe(true);
  });

  test("results can include a comment match (fallback is not AST-precise)", async () => {
    await seed();
    const results = db.findUsages("getDB", true, 30);
    expect(results.some((r) => r.path.endsWith("comment.ts"))).toBe(true);
  });
});

describe("aliased usages survive an upgrade from a pre-1.2 index", () => {
  function rawOf(d: RagDB): import("bun:sqlite").Database {
    return (d as unknown as { db: import("bun:sqlite").Database }).db;
  }

  test("migration backfills the imported column and re-resolves aliases", async () => {
    await seed(); // db.ts exports getDB; alias.ts does `import { getDB as g }; g("x")`

    // Simulate a pre-1.2 index: drop the imported column and the version stamp.
    const raw = rawOf(db);
    raw.exec("ALTER TABLE file_imports DROP COLUMN imported");
    raw.exec("PRAGMA user_version = 0");
    db.close();

    // Reopen → migrateGraphColumns re-adds `imported` AND clears the hash of
    // files that have imports, so the next index repopulates it.
    db = new RagDB(tempDir);
    const raw2 = rawOf(db);
    const hasCol = raw2
      .query<{ name: string }, []>("PRAGMA table_info(file_imports)")
      .all()
      .some((c) => c.name === "imported");
    expect(hasCol).toBe(true);
    // alias.ts and direct.ts import getDB → their hashes were cleared.
    expect(
      raw2.query<{ n: number }, []>("SELECT COUNT(*) n FROM files WHERE hash = ''").get()!.n,
    ).toBeGreaterThan(0);

    // After re-indexing, the aliased call resolves again end-to-end.
    await indexDirectory(tempDir, db, config);
    const results = db.findUsages("getDB", true, 30);
    expect(results.some((r) => r.path.endsWith("alias.ts") && r.snippet.includes('g("x")'))).toBe(true);
  });
});
