import { describe, test, expect, afterEach } from "bun:test";
import { join } from "path";
import { existsSync } from "fs";
import { writeFile } from "fs/promises";
import { createTempDir, cleanupTempDir } from "../helpers";

const CLI = join(import.meta.dir, "..", "..", "src", "main.ts");
let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) { await cleanupTempDir(tempDir); tempDir = undefined; }
});

/**
 * Run the CLI with a controlled cwd and with RAG_PROJECT_DIR cleared, so the
 * crash-log target (RAG_PROJECT_DIR || cwd) is deterministically `cwd`.
 */
async function run(cwd: string, args: string[]) {
  const env = { ...process.env };
  delete env.RAG_PROJECT_DIR;
  const proc = Bun.spawn(["bun", "run", CLI, ...args], { cwd, stdout: "pipe", stderr: "pipe", env });
  const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
  const exitCode = await proc.exited;
  return { out, exitCode };
}

describe("conversation search arg parsing", () => {
  test("a leading flag is not captured as the query", async () => {
    tempDir = await createTempDir();
    // `conversation search --top 5` would otherwise embed the literal "--top".
    const { out, exitCode } = await run(tempDir, ["conversation", "search", "--top", "5", "--dir", tempDir]);
    expect(exitCode).toBe(1);
    expect(out).toContain("Usage:");
  });
});

describe("benchmark-models dimension parsing", () => {
  test("rejects a non-numeric dimension instead of building a FLOAT[NaN] table", async () => {
    tempDir = await createTempDir();
    await writeFile(join(tempDir, "q.json"), "[]");
    const { out, exitCode } = await run(tempDir, ["benchmark-models", "q.json", "--models", "foo:abc", "--dir", tempDir]);
    expect(exitCode).toBe(1);
    expect(out).toContain("Invalid dimension");
  });
});

describe("crash-log scoping", () => {
  test("a failing CLI command does not write a server-crash log", async () => {
    tempDir = await createTempDir();
    await writeFile(join(tempDir, "q.json"), "[]");
    // This command fails (bad dim). Only `serve` should persist a crash log;
    // a CLI error must not leave a misleading "server crashed" file behind.
    const { exitCode } = await run(tempDir, ["benchmark-models", "q.json", "--models", "foo:abc"]);
    expect(exitCode).toBe(1);
    expect(existsSync(join(tempDir, ".mimirs", "server-error.log"))).toBe(false);
  });
});
