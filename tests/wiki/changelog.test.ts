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

// changelog reads git + the wiki dir from ctx.projectDir; a stub db is enough.
function changelog(projectDir: string): Promise<string> {
  const ctx: WikiContext = { db: undefined as unknown as RagDB, projectDir, version: "test" };
  return runWikiRebuild(ctx, "changelog");
}

function git(cwd: string, ...args: string[]) {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "ignore", stderr: "ignore" });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
}

// Commit N flow pages so the working tree has a clean wiki baseline to diff.
function seedWikiRepo(dir: string, pageCount: number) {
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@t.t");
  git(dir, "config", "user.name", "t");
  mkdirSync(join(dir, "wiki", "cli"), { recursive: true });
  for (let i = 0; i < pageCount; i++) {
    writeFileSync(join(dir, "wiki", "cli", `cmd${i}.md`), `# Command ${i}\n\nOriginal behavior.\n`);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "seed wiki");
}

describe("wiki(changelog)", () => {
  test("degrades gracefully with no git and no wiki — reports nothing pending", async () => {
    tempDir = await createTempDir();
    const out = await changelog(tempDir);
    expect(out).toContain("wiki/CHANGELOG.md");
    expect(out).toContain("## Changelog signal");
    expect(out).toContain("Update type: none");
    expect(out).not.toContain("{{");
  });

  test("incremental: one changed page of many → diff included for summarizing", async () => {
    tempDir = await createTempDir();
    seedWikiRepo(tempDir, 5);
    // Change a single page (1 of 5 = 20% < 60% threshold → incremental).
    writeFileSync(join(tempDir, "wiki", "cli", "cmd0.md"), "# Command 0\n\nNow validates its input first.\n");

    const out = await changelog(tempDir);
    expect(out).toContain("Update type: incremental (1 page changed)");
    expect(out).toContain("- cli/cmd0 (modified)");
    expect(out).toContain("### Wiki diff");
    expect(out).toContain("Now validates its input first."); // the actual diff content
  });

  test("full regeneration: most pages changed → one-liner, no diff dump", async () => {
    tempDir = await createTempDir();
    seedWikiRepo(tempDir, 5);
    // Change 4 of 5 (80% >= 60% threshold → full regen).
    for (let i = 0; i < 4; i++) {
      writeFileSync(join(tempDir, "wiki", "cli", `cmd${i}.md`), `# Command ${i}\n\nRewritten ${i}.\n`);
    }

    const out = await changelog(tempDir);
    expect(out).toContain("Update type: full regeneration (4 of 5 pages changed)");
    expect(out).not.toContain("### Wiki diff"); // no diff for a full regen
  });
});
