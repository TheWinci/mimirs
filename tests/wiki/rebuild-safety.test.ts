import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { runWikiRebuild } from "../../src/wiki/rebuild";
import { RagDB } from "../../src/db";
import { createTempDir, cleanupTempDir } from "../helpers";

let tempDir: string;
let db: RagDB;

beforeEach(async () => {
  tempDir = await createTempDir();
  db = new RagDB(tempDir);
});
afterEach(async () => {
  db.close();
  await cleanupTempDir(tempDir);
});

function ctx() {
  return { db, projectDir: tempDir, version: "test" };
}

describe("wiki command safety", () => {
  test("rejects a path-traversal slug (can't escape wiki/)", async () => {
    await expect(runWikiRebuild(ctx(), "write:page:../../escape")).rejects.toThrow(/traversal|absolute/i);
  });

  test("rejects an absolute slug", async () => {
    await expect(runWikiRebuild(ctx(), "write:page:/etc/passwd")).rejects.toThrow(/traversal|absolute|Empty selector/i);
  });

  test("rejects extra ':' segments instead of silently truncating", async () => {
    await expect(runWikiRebuild(ctx(), "write:page:a:b")).rejects.toThrow(/segment|slug/i);
  });

  test("missing discovery gives a directed error, not a raw ENOENT", async () => {
    // A normal slug, but no wiki/_discovery.json exists yet.
    await expect(runWikiRebuild(ctx(), "write:page:tools-search")).rejects.toThrow(/wiki\(shape\)|discovery/i);
  });
});
