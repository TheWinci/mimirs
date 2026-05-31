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

function changelog(projectDir: string): Promise<string> {
  const ctx: WikiContext = { db: undefined as unknown as RagDB, projectDir, version: "test" };
  return runWikiRebuild(ctx, "changelog");
}

function git(cwd: string, ...args: string[]) {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "ignore", stderr: "ignore" });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
}

const PAGE = (i: number) => `# Command ${i}\n\nLine A\nLine B\nLine C\nLine D\nLine E\nLine F\n`;

// Commit N multi-line flow pages so the working tree has a clean wiki baseline.
function seedWikiRepo(dir: string, pageCount: number) {
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@t.t");
  git(dir, "config", "user.name", "t");
  mkdirSync(join(dir, "wiki", "cli"), { recursive: true });
  for (let i = 0; i < pageCount; i++) {
    writeFileSync(join(dir, "wiki", "cli", `cmd${i}.md`), PAGE(i));
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "seed wiki");
}

describe("wiki(changelog) — effect-based, per-page churn", () => {
  test("nothing pending with no git/wiki", async () => {
    tempDir = await createTempDir();
    const out = await changelog(tempDir);
    expect(out).toContain("wiki/CHANGELOG.md");
    expect(out).toContain("## Changelog signal");
    expect(out).toContain("Pending wiki changes: 0");
    expect(out).not.toContain("{{");
  });

  test("surgical edit (a few lines) → summarized, diff included", async () => {
    tempDir = await createTempDir();
    seedWikiRepo(tempDir, 3);
    // Change one line of one page: ~12% churn, well under the 30% threshold.
    writeFileSync(join(tempDir, "wiki", "cli", "cmd0.md"), PAGE(0).replace("Line C", "Line C now validates input"));

    const out = await changelog(tempDir);
    expect(out).toContain("Surgical edits (summarize from the diffs below): cli/cmd0");
    expect(out).toContain("Refreshed wholesale (list only, do not summarize): none");
    expect(out).toContain("### Surgical page diffs");
    expect(out).toContain("Line C now validates input"); // the actual diff content
  });

  test("wholesale rewrite (most lines) → listed as refreshed, no diff dump", async () => {
    tempDir = await createTempDir();
    seedWikiRepo(tempDir, 3);
    // Replace the whole page: ~100% churn, over the threshold.
    writeFileSync(join(tempDir, "wiki", "cli", "cmd0.md"), "# Command 0\n\nCompletely different prose.\nMore new prose.\n");

    const out = await changelog(tempDir);
    expect(out).toContain("Refreshed wholesale (list only, do not summarize): cli/cmd0");
    expect(out).toContain("Surgical edits (summarize from the diffs below): none");
    expect(out).not.toContain("### Surgical page diffs"); // no diff when nothing surgical
  });

  test("a brand-new page is reported under New pages", async () => {
    tempDir = await createTempDir();
    seedWikiRepo(tempDir, 2);
    writeFileSync(join(tempDir, "wiki", "cli", "fresh.md"), PAGE(9));

    const out = await changelog(tempDir);
    expect(out).toContain("New pages: cli/fresh");
  });
});
