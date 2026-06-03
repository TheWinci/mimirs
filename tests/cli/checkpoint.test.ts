import { describe, test, expect, afterEach } from "bun:test";
import { join } from "path";
import { createTempDir, cleanupTempDir } from "../helpers";

const CLI = join(import.meta.dir, "..", "..", "src", "main.ts");
let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) { await cleanupTempDir(tempDir); tempDir = undefined; }
});

async function run(args: string[]) {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], { stdout: "pipe", stderr: "pipe", env: process.env });
  const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
  const exitCode = await proc.exited;
  return { out, exitCode };
}

describe("checkpoint create arg parsing", () => {
  test("summary omitted (only a flag follows) errors instead of capturing the flag", async () => {
    tempDir = await createTempDir();
    // `--dir` must not be swallowed as the summary positional.
    const { out, exitCode } = await run(["checkpoint", "create", "bugfix", "my title", "--dir", tempDir]);
    expect(exitCode).toBe(1);
    expect(out).toContain("Usage:");

    const list = await run(["checkpoint", "list", "--dir", tempDir]);
    expect(list.out).toContain("No checkpoints found."); // nothing was created
  });
});
