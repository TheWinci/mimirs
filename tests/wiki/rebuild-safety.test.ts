import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
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

describe("mechanism page validation", () => {
  // validate-discovery reads wiki/_discovery.json and checks primaryFiles exist
  // on disk, so each case writes both the discovery file and a real source file.
  async function validate(pages: Record<string, unknown>[], flows = [{ id: "flow-a" }]): Promise<string> {
    await mkdir(join(tempDir, "src"), { recursive: true });
    await writeFile(join(tempDir, "src", "a.ts"), "export const a = 1;\n");
    await mkdir(join(tempDir, "wiki"), { recursive: true });
    await writeFile(join(tempDir, "wiki", "_discovery.json"), JSON.stringify({ metadata: { schemaVersion: 1 }, flows, pages }));
    return runWikiRebuild(ctx(), "validate-discovery");
  }

  test("a valid mechanism page passes", async () => {
    const out = await validate([
      { slug: "mechanisms/ranking", title: "Ranking", kind: "mechanism", flowIds: ["flow-a"], primaryFiles: ["src/a.ts"] },
    ]);
    expect(out).toContain("passed structural checks");
  });

  test("flowIds is optional for a mechanism page", async () => {
    const out = await validate([
      { slug: "mechanisms/ranking", title: "Ranking", kind: "mechanism", primaryFiles: ["src/a.ts"] },
    ]);
    expect(out).toContain("passed structural checks");
  });

  test("the bare `mechanisms` slug is rejected", async () => {
    const out = await validate([
      { slug: "mechanisms", title: "All mechanisms", kind: "mechanism", primaryFiles: ["src/a.ts"] },
    ]);
    expect(out).toContain("must start with `mechanisms/`");
  });

  test("a mechanism slug outside mechanisms/ is rejected", async () => {
    const out = await validate([
      { slug: "internals/ranking", title: "Ranking", kind: "mechanism", primaryFiles: ["src/a.ts"] },
    ]);
    expect(out).toContain("must start with `mechanisms/`");
  });

  test("a non-mechanism page cannot use a mechanisms/ slug", async () => {
    const out = await validate([
      { slug: "mechanisms/ranking", title: "Ranking", kind: "tool", flowIds: ["flow-a"], primaryFiles: ["src/a.ts"] },
    ]);
    expect(out).toContain("reserved for mechanism pages");
  });

  test("an unresolved flowIds entry is rejected", async () => {
    const out = await validate([
      { slug: "mechanisms/ranking", title: "Ranking", kind: "mechanism", flowIds: ["flow-missing"], primaryFiles: ["src/a.ts"] },
    ]);
    expect(out).toContain("references missing flow id");
  });

  test("a mechanism page without primaryFiles is rejected", async () => {
    const out = await validate([
      { slug: "mechanisms/ranking", title: "Ranking", kind: "mechanism" },
    ]);
    expect(out).toContain("primaryFiles is missing");
  });

  test("two mechanism pages may reference the same flow, which a flow page also owns", async () => {
    const out = await validate([
      { slug: "tools/a", title: "A", kind: "tool", flowIds: ["flow-a"], primaryFiles: ["src/a.ts"] },
      { slug: "mechanisms/ranking", title: "Ranking", kind: "mechanism", flowIds: ["flow-a"], primaryFiles: ["src/a.ts"] },
      { slug: "mechanisms/caching", title: "Caching", kind: "mechanism", flowIds: ["flow-a"], primaryFiles: ["src/a.ts"] },
    ]);
    expect(out).toContain("passed structural checks");
  });

  test("flow page rules are unchanged: exactly one flow id", async () => {
    const out = await validate(
      [{ slug: "tools/a", title: "A", kind: "tool", flowIds: ["flow-a", "flow-b"], primaryFiles: ["src/a.ts"] }],
      [{ id: "flow-a" }, { id: "flow-b" }],
    );
    expect(out).toContain("exactly one flow id");
  });
});
