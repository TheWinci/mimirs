import { describe, test, expect, afterEach } from "bun:test";
import { runWikiRebuild, type WikiContext } from "../../src/wiki/rebuild";
import type { RagDB } from "../../src/db";
import { createTempDir, cleanupTempDir } from "../helpers";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) {
    await cleanupTempDir(tempDir);
    tempDir = undefined;
  }
});

function update(projectDir: string): Promise<string> {
  const ctx: WikiContext = { db: undefined as unknown as RagDB, projectDir, version: "test" };
  return runWikiRebuild(ctx, "update");
}

function git(cwd: string, ...args: string[]) {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "ignore", stderr: "ignore" });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
}

function headHash(cwd: string): string {
  return Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd }).stdout.toString().trim();
}

// A repo with a committed wiki (so the last-wiki-commit baseline is reachable) and
// some source. Returns the commit the wiki was committed at.
function seedRepo(dir: string): string {
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@t.t");
  git(dir, "config", "user.name", "t");
  mkdirSync(join(dir, "lib"), { recursive: true });
  mkdirSync(join(dir, "wiki", "cli"), { recursive: true });
  writeFileSync(join(dir, "lib", "foo.ts"), "export const foo = 1;\n");
  writeFileSync(join(dir, "lib", "bar.ts"), "export const bar = 2;\n");
  writeFileSync(join(dir, "wiki", "cli", "foo.md"), "# foo\n");
  writeFileSync(join(dir, "wiki", "_discovery.json"), JSON.stringify({ pages: [{ slug: "cli/foo", title: "The foo command" }] }));
  writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ a: 1 }));
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "seed");
  return headHash(dir);
}

describe("wiki(update)", () => {
  test("no git → graceful, recommends regeneration", async () => {
    tempDir = await createTempDir();
    const out = await update(tempDir);
    expect(out).toContain("## Update signal");
    expect(out).toContain("Could not anchor a baseline");
    expect(out).not.toContain("{{");
  });

  test("no changes since the wiki commit → nothing to update", async () => {
    tempDir = await createTempDir();
    seedRepo(tempDir);
    const out = await update(tempDir);
    expect(out).toContain("nothing to update");
  });

  test("excludes wiki/ and lockfiles, includes code in any dir, lists the page index", async () => {
    tempDir = await createTempDir();
    seedRepo(tempDir);
    // Change source (outside any src/ dir), a wiki page, and a lockfile.
    writeFileSync(join(tempDir, "lib", "foo.ts"), "export const foo = 42; // changed\n");
    writeFileSync(join(tempDir, "wiki", "cli", "foo.md"), "# foo\n\nrewritten\n");
    writeFileSync(join(tempDir, "package-lock.json"), JSON.stringify({ a: 2 }));

    const out = await update(tempDir);
    expect(out).toContain("lib/foo.ts"); // code change, no src/ folder
    expect(out).not.toContain("package-lock.json"); // lockfile excluded
    expect(out).not.toContain("wiki/cli/foo.md"); // wiki output excluded
    expect(out).toContain("### Cause diff");
    expect(out).toContain("// changed");
    expect(out).toContain("cli/foo — The foo command"); // page index
  });

  test("a bogus changelog stamp is unreachable → falls back to the last wiki commit", async () => {
    tempDir = await createTempDir();
    seedRepo(tempDir);
    writeFileSync(join(tempDir, "wiki", "CHANGELOG.md"), "# Wiki Changelog\n\n## [deadbee] - 2026-01-01\n\nold\n");
    git(tempDir, "add", "-A");
    git(tempDir, "commit", "-qm", "add changelog");
    // change source so there's something to report
    writeFileSync(join(tempDir, "lib", "bar.ts"), "export const bar = 99;\n");

    const out = await update(tempDir);
    expect(out).toContain("unreachable");
    expect(out).toContain("last wiki/ commit");
    expect(out).toContain("lib/bar.ts");
  });
});
