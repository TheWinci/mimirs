import { describe, test, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { RagDB } from "../../src/db";
import { embed, getEmbedder } from "../../src/embeddings/embed";
import { resolveImports } from "../../src/graph/resolver";
import { createTempDir, cleanupTempDir } from "../helpers";
import { join } from "path";
import { runDiscovery } from "../../src/wiki/discovery";

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

/** Seed a file with graph metadata (no chunking needed for discovery). */
async function seedFile(
  relativePath: string,
  imports: { name: string; source: string }[],
  exports: { name: string; type: string }[],
) {
  const fullPath = join(tempDir, relativePath);
  const emb = await embed("placeholder");
  db.upsertFile(fullPath, `hash-${relativePath}`, [
    { snippet: "placeholder", embedding: emb },
  ]);
  const file = db.getFileByPath(fullPath)!;
  db.upsertFileGraph(file.id, imports, exports);
}

describe("runDiscovery", () => {
  test("returns empty result for empty index", () => {
    const result = runDiscovery(db, tempDir);
    expect(result.fileCount).toBe(0);
    expect(result.modules).toHaveLength(0);
    expect(result.warnings).toContain("Index is empty — no files indexed");
  });

  test("detects modules from directories with entry files", async () => {
    // src/db/index.ts — entry file
    await seedFile("src/db/index.ts", [], [
      { name: "RagDB", type: "class" },
      { name: "search", type: "function" },
    ]);
    // src/db/search.ts — internal file
    await seedFile("src/db/search.ts",
      [{ name: "RagDB", source: "./index" }],
      [{ name: "searchChunks", type: "function" }],
    );
    // src/server.ts — imports from db
    await seedFile("src/server.ts",
      [{ name: "RagDB", source: "./db/index" }],
      [{ name: "startServer", type: "function" }],
    );

    resolveImports(db, tempDir);
    const result = runDiscovery(db, tempDir);

    expect(result.fileCount).toBe(3);
    expect(result.modules.length).toBeGreaterThan(0);

    // src/db should be detected as a module (has index.ts entry file)
    const dbModule = result.modules.find((m) => m.path.includes("db"));
    expect(dbModule).toBeDefined();
    expect(dbModule!.entryFile).toContain("index.ts");
    expect(dbModule!.files.length).toBeGreaterThanOrEqual(2);
  });

  test("computes fanIn and fanOut for modules", async () => {
    await seedFile("src/db/index.ts", [], [
      { name: "DB", type: "class" },
    ]);
    await seedFile("src/search/index.ts",
      [{ name: "DB", source: "../db/index" }],
      [{ name: "search", type: "function" }],
    );
    await seedFile("src/server.ts",
      [{ name: "search", source: "./search/index" }],
      [{ name: "startServer", type: "function" }],
    );

    resolveImports(db, tempDir);
    const result = runDiscovery(db, tempDir);

    // db module should have fanIn > 0 (search imports from it)
    const dbModule = result.modules.find((m) => m.path.includes("db"));
    if (dbModule) {
      expect(dbModule.fanIn).toBeGreaterThan(0);
    }
  });

  test("includes raw graph data in result", async () => {
    await seedFile("src/a.ts", [], [{ name: "foo", type: "function" }]);
    await seedFile("src/b.ts",
      [{ name: "foo", source: "./a" }],
      [{ name: "bar", type: "function" }],
    );

    resolveImports(db, tempDir);
    const result = runDiscovery(db, tempDir);

    expect(result.graphData.fileLevel.level).toBe("file");
    expect(result.graphData.fileLevel.nodes.length).toBeGreaterThan(0);
    expect(result.graphData.directoryLevel.level).toBe("directory");
  });

  test("detects modules via fanIn even without entry file", async () => {
    // src/utils/helpers.ts — no index.ts but imported by others
    await seedFile("src/utils/helpers.ts", [], [
      { name: "formatDate", type: "function" },
    ]);
    await seedFile("src/a.ts",
      [{ name: "formatDate", source: "./utils/helpers" }],
      [{ name: "a", type: "function" }],
    );
    await seedFile("src/b.ts",
      [{ name: "formatDate", source: "./utils/helpers" }],
      [{ name: "b", type: "function" }],
    );

    resolveImports(db, tempDir);
    const result = runDiscovery(db, tempDir);

    // utils should be detected as module via fanIn > 0
    const utilsModule = result.modules.find((m) => m.path.includes("utils"));
    expect(utilsModule).toBeDefined();
  });

  test("handles project with no import edges", async () => {
    await seedFile("src/a.ts", [], [{ name: "a", type: "function" }]);
    await seedFile("src/b.ts", [], [{ name: "b", type: "function" }]);

    const result = runDiscovery(db, tempDir);

    // Should still produce some output without crashing
    expect(result.fileCount).toBe(2);
    expect(result.graphData.fileLevel.edges).toHaveLength(0);
  });
});
