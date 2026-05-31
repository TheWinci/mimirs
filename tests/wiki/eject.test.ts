import { describe, test, expect, afterEach } from "bun:test";
import { runWikiRebuild, type WikiContext } from "../../src/wiki/rebuild";
import type { RagDB } from "../../src/db";
import { createTempDir, cleanupTempDir } from "../helpers";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) {
    await cleanupTempDir(tempDir);
    tempDir = undefined;
  }
});

// eject only reads ctx.projectDir, so a stub db is enough.
function eject(projectDir: string, input = "eject"): Promise<string> {
  const ctx: WikiContext = { db: undefined as unknown as RagDB, projectDir, version: "test" };
  return runWikiRebuild(ctx, input);
}

const FILES = [
  "README.md",
  "discovery.md",
  "write.md",
  "writing-contract.md",
  "self-check.md",
  "page-flow.md",
  "page-overview.md",
  "page-screen.md",
];

describe("wiki(eject)", () => {
  test("writes the instruction defaults into .mimirs/wiki/", async () => {
    tempDir = await createTempDir();
    const out = await eject(tempDir);
    const wikiDir = join(tempDir, ".mimirs", "wiki");
    for (const f of FILES) {
      expect(existsSync(join(wikiDir, f))).toBe(true);
    }
    expect(out).toContain("Wrote:");
    expect(out).toContain("discovery.md");
  });

  test("does not clobber an edited file without force, but eject:force does", async () => {
    tempDir = await createTempDir();
    await eject(tempDir);
    const contract = join(tempDir, ".mimirs", "wiki", "writing-contract.md");
    writeFileSync(contract, "MY EDITS");

    const out = await eject(tempDir);
    expect(readFileSync(contract, "utf-8")).toBe("MY EDITS");
    expect(out).toContain("Skipped");

    const forced = await eject(tempDir, "eject:force");
    expect(readFileSync(contract, "utf-8")).not.toBe("MY EDITS");
    expect(forced).toContain("Wrote:");
  });
});
