import { describe, test, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { search, searchChunks } from "../../src/search/hybrid";
import { RagDB } from "../../src/db";
import { embed, getEmbedder } from "../../src/embeddings/embed";
import { createTempDir, cleanupTempDir } from "../helpers";
import { join } from "path";

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

async function seedWithPaths() {
  const srcDir = join(tempDir, "src");
  const testsDir = join(tempDir, "tests");
  const docsDir = join(tempDir, "docs");

  const files = [
    { path: join(srcDir, "auth.ts"), text: "export function authenticate user with password check" },
    { path: join(srcDir, "auth.py"), text: "def authenticate user with password check" },
    { path: join(testsDir, "auth.test.ts"), text: "test authentication user password" },
    { path: join(docsDir, "auth.md"), text: "Authentication guide for users" },
  ];
  for (const f of files) {
    const emb = await embed(f.text);
    db.upsertFile(f.path, `hash-${f.path}`, [{ snippet: f.text, embedding: emb }]);
  }
  return { srcDir, testsDir, docsDir };
}

describe("scoped search — extensions filter", () => {
  test("restricts results to the listed extensions", async () => {
    await seedWithPaths();
    const results = await search("authenticate user password", db, 10, 0, 0.7, [], {
      extensions: [".ts"],
    });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.path.endsWith(".ts")).toBe(true);
    }
  });

  test("accepts extensions without leading dot", async () => {
    await seedWithPaths();
    const results = await search("authenticate user password", db, 10, 0, 0.7, [], {
      extensions: ["py"],
    });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.path.endsWith(".py")).toBe(true);
    }
  });
});

describe("scoped search — dirs filter", () => {
  test("includes only matching directories", async () => {
    const { srcDir } = await seedWithPaths();
    const results = await search("authenticate user password", db, 10, 0, 0.7, [], {
      dirs: [srcDir],
    });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.path.startsWith(srcDir + "/")).toBe(true);
    }
  });

  test("excludeDirs removes matching results", async () => {
    const { testsDir } = await seedWithPaths();
    const results = await search("authenticate user password", db, 10, 0, 0.7, [], {
      excludeDirs: [testsDir],
    });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.path.startsWith(testsDir + "/")).toBe(false);
    }
  });

  test("extensions and dirs combine (logical AND)", async () => {
    const { srcDir } = await seedWithPaths();
    const results = await search("authenticate user password", db, 10, 0, 0.7, [], {
      extensions: [".ts"],
      dirs: [srcDir],
    });
    for (const r of results) {
      expect(r.path.endsWith(".ts")).toBe(true);
      expect(r.path.startsWith(srcDir + "/")).toBe(true);
    }
  });

  test("returns empty when filter excludes everything", async () => {
    await seedWithPaths();
    const results = await search("authenticate user password", db, 10, 0, 0.7, [], {
      extensions: [".rs"],
    });
    expect(results).toEqual([]);
  });
});

describe("scoped search — chunk-level", () => {
  test("searchChunks honors the extension filter", async () => {
    await seedWithPaths();
    const results = await searchChunks("authenticate user password", db, 10, 0, 0.7, [], {
      extensions: [".md"],
    });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.path.endsWith(".md")).toBe(true);
    }
  });
});
