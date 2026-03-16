import { describe, test, expect, beforeAll, beforeEach, afterEach } from "bun:test";
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

async function seedUsages() {
  // Definition file — exports "getDB"
  const defSnippet = `export function getDB(path: string): Database {
  return new Database(path);
}`;
  const defEmb = await embed(defSnippet);
  db.upsertFile("/src/db.ts", "hash-db", [
    { snippet: defSnippet, embedding: defEmb, startLine: 1, endLine: 3 },
  ]);
  const defFile = db.getFileByPath("/src/db.ts")!;
  db.upsertFileGraph(defFile.id, [], [{ name: "getDB", type: "function" }]);

  // Usage file — calls getDB but doesn't export it
  const useSnippet = `import { getDB } from "./db";

export function initServer(): void {
  const database = getDB("./data.db");
  database.run("SELECT 1");
}`;
  const useEmb = await embed(useSnippet);
  db.upsertFile("/src/server.ts", "hash-server", [
    { snippet: useSnippet, embedding: useEmb, startLine: 1, endLine: 6 },
  ]);

  // Another usage in a different file
  const use2Snippet = `const db = getDB(process.env.DB_PATH!);`;
  const use2Emb = await embed(use2Snippet);
  db.upsertFile("/src/worker.ts", "hash-worker", [
    { snippet: use2Snippet, embedding: use2Emb, startLine: 5, endLine: 5 },
  ]);
}

describe("findUsages", () => {
  test("returns usage files but excludes the defining file", async () => {
    await seedUsages();

    const results = db.findUsages("getDB", true, 10);

    const paths = results.map((r) => r.path);
    expect(paths).not.toContain("/src/db.ts");
    expect(paths.some((p) => p === "/src/server.ts" || p === "/src/worker.ts")).toBe(true);
  });

  test("exact match does not return superstring symbols", async () => {
    // Seed a definition for "getDBForProject" (different symbol)
    const defSnippet = `export function getDBForProject(id: string): Database {
  return new Database(id);
}`;
    const defEmb = await embed(defSnippet);
    db.upsertFile("/src/project-db.ts", "hash-proj", [
      { snippet: defSnippet, embedding: defEmb },
    ]);

    // Usage file contains only "getDBForProject", not "getDB"
    const useSnippet = `const db = getDBForProject("my-project");`;
    const useEmb = await embed(useSnippet);
    db.upsertFile("/src/app.ts", "hash-app", [
      { snippet: useSnippet, embedding: useEmb },
    ]);

    // "getDB" with exact=true should NOT match "getDBForProject"
    const results = db.findUsages("getDB", true, 10);
    const paths = results.map((r) => r.path);
    expect(paths).not.toContain("/src/app.ts");
  });

  test("exact:false returns results for symbols found by FTS", async () => {
    // "getDB_cache" — FTS5 splits on "_", so token "getDB" is indexed and found
    const snippet = `const x = getDB_cache;`;
    const emb = await embed(snippet);
    db.upsertFile("/src/cache.ts", "hash-cache", [{ snippet, embedding: emb }]);

    const results = db.findUsages("getDB", false, 10);
    expect(results.some((r) => r.path === "/src/cache.ts")).toBe(true);
  });

  test("returns empty array for unknown symbol", async () => {
    await seedUsages();
    const results = db.findUsages("nonExistentSymbolXYZ", true, 10);
    expect(results).toEqual([]);
  });

  test("returns empty array for special-char symbol that fails FTS", async () => {
    const results = db.findUsages("a[b]c", true, 10);
    expect(results).toEqual([]);
  });

  test("respects top limit", async () => {
    // Index many files that all reference "helper"
    for (let i = 0; i < 5; i++) {
      const snippet = `const x = helper(${i});`;
      const emb = await embed(snippet);
      db.upsertFile(`/src/file${i}.ts`, `hash-${i}`, [{ snippet, embedding: emb }]);
    }

    const results = db.findUsages("helper", false, 3);
    expect(results.length).toBeLessThanOrEqual(3);
  });
});
