import { describe, test, expect, beforeAll, afterEach } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";
import { RagDB } from "../../src/db";
import { indexDirectory } from "../../src/indexing/indexer";
import { getEmbedder } from "../../src/embeddings/embed";
import { createTempDir, cleanupTempDir, writeFixture } from "../helpers";
import type { RagConfig } from "../../src/config";

const CLI = join(import.meta.dir, "..", "..", "src", "main.ts");
let tempDir: string | undefined;
const cfg: RagConfig = {
  include: ["**/*.ts"],
  exclude: ["node_modules/**", ".git/**", ".mimirs/**"],
  chunkSize: 2048,
  chunkOverlap: 50,
};

beforeAll(async () => {
  await getEmbedder();
});
afterEach(async () => {
  if (tempDir) {
    await cleanupTempDir(tempDir);
    tempDir = undefined;
  }
});

async function runAffected(cwd: string, ...args: string[]) {
  const proc = Bun.spawn(["bun", "run", CLI, "affected", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const out = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { out, exitCode };
}

async function runAffectedStdin(stdin: string, ...args: string[]) {
  const proc = Bun.spawn(["bun", "run", CLI, "affected", "--stdin", ...args], {
    stdin: new Response(stdin),
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const out = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { out, exitCode };
}

describe("affected resolves changed files against --dir, not cwd", () => {
  test("finds the affected test from a cwd different than --dir", async () => {
    tempDir = await createTempDir();
    await writeFixture(tempDir, "src/a.ts", "export function fn() { return 1; }\n");
    await writeFixture(tempDir, "tests/a.test.ts", `import { fn } from "../src/a";\ntest("a", () => { fn(); });\n`);
    const db = new RagDB(tempDir);
    await indexDirectory(tempDir, db, cfg);
    db.close();

    // cwd is NOT the project — the old code resolved against cwd and matched nothing.
    const { out, exitCode } = await runAffected(tmpdir(), "src/a.ts", "--dir", tempDir, "--quiet");
    expect(exitCode).toBe(0);
    expect(out).toContain("a.test.ts");
  });

  test("empty stdin under --json emits valid empty JSON (CI contract)", async () => {
    tempDir = await createTempDir();
    const { out, exitCode } = await runAffectedStdin("", "--json", "--dir", tempDir);
    expect(exitCode).toBe(0);
    // A consumer doing JSON.parse(output) must not throw.
    expect(() => JSON.parse(out)).not.toThrow();
    expect(JSON.parse(out)).toEqual({ changed: [], unknown: [], tests: [] });
  });

  test("empty stdin under --quiet emits nothing (no blank arg)", async () => {
    tempDir = await createTempDir();
    const { out } = await runAffectedStdin("", "--quiet", "--dir", tempDir);
    expect(out).toBe("");
  });
});
