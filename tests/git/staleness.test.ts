import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "path";
import { writeFileSync } from "fs";
import { createTempDir, cleanupTempDir } from "../helpers";
import { computeFreshness, freshnessTag } from "../../src/git/staleness";
import { getHeadSha } from "../../src/git/exec";

// Minimal git helper for the test (synchronous, throws on failure).
function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

let repo: string;
let firstSha: string;

beforeAll(async () => {
  repo = await createTempDir();
  git(repo, "init", "-q");
  writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
  writeFileSync(join(repo, "b.ts"), "export const b = 1;\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "first");
  firstSha = git(repo, "rev-parse", "HEAD");

  // A second commit that changes ONLY a.ts.
  writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "change a");
});

afterAll(async () => {
  await cleanupTempDir(repo);
});

describe("computeFreshness", () => {
  test("stamped at HEAD → current", async () => {
    const head = await getHeadSha(repo);
    const [f] = await computeFreshness(repo, [{ commitHash: head, filesInvolved: ["a.ts"] }]);
    expect(f?.state).toBe("current");
  });

  test("a file changed since the stamp → stale, lists the file", async () => {
    const [f] = await computeFreshness(repo, [{ commitHash: firstSha, filesInvolved: ["a.ts"] }]);
    expect(f?.state).toBe("stale");
    expect(f?.changedFiles).toContain("a.ts");
  });

  test("an unchanged file at an old stamp → current", async () => {
    // b.ts was never touched after firstSha.
    const [f] = await computeFreshness(repo, [{ commitHash: firstSha, filesInvolved: ["b.ts"] }]);
    expect(f?.state).toBe("current");
  });

  test("a commit not in history → diverged", async () => {
    const fake = "0".repeat(40);
    const [f] = await computeFreshness(repo, [{ commitHash: fake, filesInvolved: ["a.ts"] }]);
    expect(f?.state).toBe("diverged");
  });

  test("unstamped (null) and empty-files rows → no signal", async () => {
    const out = await computeFreshness(repo, [
      { commitHash: null, filesInvolved: ["a.ts"] },
      { commitHash: firstSha, filesInvolved: [] },
    ]);
    expect(out[0]).toBeNull();
    expect(out[1]).toBeNull();
  });

  test("non-git directory → all null", async () => {
    const plain = await createTempDir();
    try {
      const out = await computeFreshness(plain, [{ commitHash: firstSha, filesInvolved: ["a.ts"] }]);
      expect(out[0]).toBeNull();
    } finally {
      await cleanupTempDir(plain);
    }
  });

  test("diffs are cached per sha — a mixed set resolves correctly", async () => {
    const head = await getHeadSha(repo);
    const out = await computeFreshness(repo, [
      { commitHash: firstSha, filesInvolved: ["a.ts"] }, // stale
      { commitHash: firstSha, filesInvolved: ["b.ts"] }, // current (same sha, cached diff)
      { commitHash: head, filesInvolved: ["a.ts"] }, // current
    ]);
    expect(out.map((f) => f?.state)).toEqual(["stale", "current", "current"]);
  });
});

describe("freshnessTag", () => {
  test("renders a tag per state, empty for no signal", () => {
    expect(freshnessTag(null)).toBe("");
    expect(freshnessTag({ state: "current", changedFiles: [] })).toContain("current");
    expect(freshnessTag({ state: "stale", changedFiles: ["a.ts"] })).toContain("a.ts");
    expect(freshnessTag({ state: "diverged", changedFiles: [] })).toContain("not in current history");
  });
});
