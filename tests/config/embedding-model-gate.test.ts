import { describe, test, expect, afterEach } from "bun:test";
import { configureEmbedder, getEmbeddingDim, DEFAULT_MODEL_ID, DEFAULT_EMBEDDING_DIM } from "../../src/embeddings/embed";
import { applyEmbeddingConfigFromDisk } from "../../src/config";
import { createTempDir, cleanupTempDir } from "../helpers";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

// A project-local .mimirs/config.json is attacker-controllable: a cloned repo
// can ship one. An arbitrary `embeddingModel` from it is honored ONLY when the
// operator sets MIMIRS_ALLOW_CUSTOM_MODEL=1. Otherwise it falls back to the
// pinned default. We observe the decision through the embedding dim: a custom
// model carries a custom dim (512), so dim 384 means "fell back to default".

let tempDir: string | undefined;

afterEach(async () => {
  delete process.env.MIMIRS_ALLOW_CUSTOM_MODEL;
  // Restore the global embedder so other suites see the default.
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

describe("untrusted embeddingModel from project config is gated", () => {
  test("a non-default model is IGNORED without the opt-in (falls back to default)", async () => {
    tempDir = await createTempDir();
    writeConfig(tempDir, { embeddingModel: "attacker/model-512", embeddingDim: 512 });

    applyEmbeddingConfigFromDisk(tempDir);

    // Custom model rejected → default model + default dim, not the config's 512.
    expect(getEmbeddingDim()).toBe(DEFAULT_EMBEDDING_DIM);
  });

  test("a non-default model is HONORED with MIMIRS_ALLOW_CUSTOM_MODEL=1", async () => {
    tempDir = await createTempDir();
    process.env.MIMIRS_ALLOW_CUSTOM_MODEL = "1";
    writeConfig(tempDir, { embeddingModel: "operator/model-512", embeddingDim: 512 });

    applyEmbeddingConfigFromDisk(tempDir);

    expect(getEmbeddingDim()).toBe(512);
  });

  test("the opt-in must be exactly \"1\" — other truthy values do not enable it", async () => {
    tempDir = await createTempDir();
    process.env.MIMIRS_ALLOW_CUSTOM_MODEL = "true";
    writeConfig(tempDir, { embeddingModel: "attacker/model-512", embeddingDim: 512 });

    applyEmbeddingConfigFromDisk(tempDir);

    expect(getEmbeddingDim()).toBe(DEFAULT_EMBEDDING_DIM);
  });

  test("the default model is always honored (no opt-in needed)", async () => {
    tempDir = await createTempDir();
    writeConfig(tempDir, { embeddingModel: DEFAULT_MODEL_ID, embeddingDim: DEFAULT_EMBEDDING_DIM });

    applyEmbeddingConfigFromDisk(tempDir);

    expect(getEmbeddingDim()).toBe(DEFAULT_EMBEDDING_DIM);
  });

  test("a config with no embeddingModel uses the default (no opt-in needed)", async () => {
    tempDir = await createTempDir();
    writeConfig(tempDir, { chunkSize: 256 });

    applyEmbeddingConfigFromDisk(tempDir);

    expect(getEmbeddingDim()).toBe(DEFAULT_EMBEDDING_DIM);
  });
});
