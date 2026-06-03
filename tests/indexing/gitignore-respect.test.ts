import { describe, test, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { rm } from "fs/promises";
import { indexDirectory } from "../../src/indexing/indexer";
import { RagDB } from "../../src/db";
import { getEmbedder } from "../../src/embeddings/embed";
import { createTempDir, cleanupTempDir, writeFixture } from "../helpers";
import type { RagConfig } from "../../src/config";

let tempDir: string;
let db: RagDB;

const cfg: RagConfig = {
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

function runGit(args: string[], cwd: string): Promise<number> {
  return Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "ignore" }).exited;
}

function indexedRelPaths(): string[] {
  const raw = (db as unknown as { db: import("bun:sqlite").Database }).db;
  return raw
    .query<{ path: string }, []>("SELECT path FROM files")
    .all()
    .map((r) => r.path.replace(tempDir, ""));
}

describe("indexing respects .gitignore", () => {
  test("a gitignored file is skipped even if it matches an include glob", async () => {
    await runGit(["init"], tempDir);
    await writeFixture(tempDir, ".gitignore", "mysecret.ts\ngen/\n");
    await writeFixture(tempDir, "src/a.ts", "export const a = 1;");
    await writeFixture(tempDir, "mysecret.ts", "export const secret = 1;"); // gitignored
    await writeFixture(tempDir, "gen/x.ts", "export const g = 1;"); // gitignored dir
    await writeFixture(tempDir, "src/b.ts", "export const b = 2;"); // untracked, NOT ignored
    await runGit(["add", "src/a.ts"], tempDir); // a.ts tracked; b.ts left untracked

    await indexDirectory(tempDir, db, cfg);
    const paths = indexedRelPaths();

    expect(paths.some((p) => p.endsWith("/src/a.ts"))).toBe(true); // tracked
    expect(paths.some((p) => p.endsWith("/src/b.ts"))).toBe(true); // untracked but not ignored
    expect(paths.some((p) => p.endsWith("/mysecret.ts"))).toBe(false); // gitignored
    expect(paths.some((p) => p.includes("/gen/"))).toBe(false); // gitignored directory
  });

  test("a non-git directory falls back to a full walk", async () => {
    // No git init — should still index .ts files via the recursive walk.
    await writeFixture(tempDir, "src/a.ts", "export const a = 1;");
    await indexDirectory(tempDir, db, cfg);
    expect(indexedRelPaths().some((p) => p.endsWith("/src/a.ts"))).toBe(true);
  });

  test("a fully-gitignored target still indexes via the walk fallback", async () => {
    // git sees no files under gen/ (the dir is ignored), so `git ls-files`
    // returns empty — which must fall back to a recursive walk rather than
    // returning [] and indexing nothing.
    await runGit(["init"], tempDir);
    await writeFixture(tempDir, ".gitignore", "gen/\n");
    await writeFixture(tempDir, "gen/x.ts", "export const x = 1;");

    await indexDirectory(join(tempDir, "gen"), db, cfg);
    expect(indexedRelPaths().some((p) => p.endsWith("/gen/x.ts"))).toBe(true);
  });

  test("an empty scan does not prune the existing index", async () => {
    await writeFixture(tempDir, "src/a.ts", "export const a = 1;");
    await indexDirectory(tempDir, db, cfg);
    const before = indexedRelPaths();
    expect(before.length).toBeGreaterThan(0);

    // A run that scans zero files (degenerate/empty target) must not be treated
    // as "every file was deleted" — pruneDeleted(∅) would wipe the whole index.
    const emptyDir = await createTempDir();
    try {
      await indexDirectory(emptyDir, db, cfg);
      expect(indexedRelPaths().length).toBe(before.length);
    } finally {
      await cleanupTempDir(emptyDir);
    }
  });

  test("a tracked-but-deleted working-tree file is skipped, not an error", async () => {
    await runGit(["init"], tempDir);
    await writeFixture(tempDir, "a.ts", "export const a = 1;");
    await writeFixture(tempDir, "b.ts", "export const b = 2;");
    await runGit(["add", "."], tempDir);
    // Delete a.ts from disk but leave it tracked — `git ls-files --cached`
    // still lists it, so it reaches processFile and stat() throws ENOENT.
    await rm(join(tempDir, "a.ts"));

    const result = await indexDirectory(tempDir, db, cfg);
    expect(result.errors).toEqual([]); // vanished file is skipped quietly
    const paths = indexedRelPaths();
    expect(paths.some((p) => p.endsWith("/b.ts"))).toBe(true);
    expect(paths.some((p) => p.endsWith("/a.ts"))).toBe(false);
  });
});
