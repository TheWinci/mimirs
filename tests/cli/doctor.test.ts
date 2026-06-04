import { describe, test, expect, afterEach, beforeAll, afterAll } from "bun:test";
import { join } from "path";
import { mkdirSync, writeFileSync } from "fs";
import { RagDB } from "../../src/db";
import { configureEmbedder, DEFAULT_MODEL_ID, DEFAULT_EMBEDDING_DIM } from "../../src/embeddings/embed";
import { createTempDir, cleanupTempDir } from "../helpers";

const CLI = join(import.meta.dir, "..", "..", "src", "main.ts");
let tempDir: string | undefined;

// These tests use custom embeddingModels to set up a dim mismatch, which is now
// gated behind an opt-in. Enable it in-process AND for the doctor subprocess
// (runDoctor passes process.env through). See embedding-model-gate.test.ts.
beforeAll(() => {
  process.env.MIMIRS_ALLOW_CUSTOM_MODEL = "1";
});
afterAll(() => {
  delete process.env.MIMIRS_ALLOW_CUSTOM_MODEL;
});

afterEach(async () => {
  // Building an index in-process mutates the global embedder; restore it.
  configureEmbedder(DEFAULT_MODEL_ID, DEFAULT_EMBEDDING_DIM);
  if (tempDir) {
    await cleanupTempDir(tempDir);
    tempDir = undefined;
  }
});

function writeConfig(dir: string, cfg: Record<string, unknown>): void {
  mkdirSync(join(dir, ".mimirs"), { recursive: true });
  writeFileSync(join(dir, ".mimirs", "config.json"), JSON.stringify(cfg, null, 2));
}

async function runDoctor(dir: string): Promise<{ out: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", "run", CLI, "doctor", dir], {
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
  const exitCode = await proc.exited;
  return { out, exitCode };
}

describe("doctor detects an embedding-dim mismatch", () => {
  test("exits 1 and reports the dimension mismatch", async () => {
    tempDir = await createTempDir();

    // Build an index at dim 512.
    writeConfig(tempDir, { embeddingModel: "test/model-512", embeddingDim: 512 });
    new RagDB(tempDir).close();

    // Reconfigure to a different dim — the index on disk is now incompatible.
    writeConfig(tempDir, { embeddingModel: "test/model-768", embeddingDim: 768 });

    const { out, exitCode } = await runDoctor(tempDir);
    expect(exitCode).toBe(1);
    expect(out).toMatch(/512-dim|dimension mismatch|768-dim/i);
  });

  test("a matching config reports no embedding mismatch", async () => {
    tempDir = await createTempDir();
    writeConfig(tempDir, { embeddingModel: "test/model-512", embeddingDim: 512 });
    new RagDB(tempDir).close();

    const { out } = await runDoctor(tempDir);
    // The dedicated check must not flag a mismatch for a matching config.
    expect(out).not.toMatch(/Index was built with .* but the configured/i);
    expect(out).toContain("Embedding config matches index");
  });
});
