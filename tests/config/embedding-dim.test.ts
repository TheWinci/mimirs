import { describe, test, expect, afterEach, beforeAll, afterAll } from "bun:test";
import { RagDB } from "../../src/db";
import { configureEmbedder, getEmbeddingDim, DEFAULT_MODEL_ID, DEFAULT_EMBEDDING_DIM } from "../../src/embeddings/embed";
import { applyEmbeddingConfigFromDisk } from "../../src/config";
import { createTempDir, cleanupTempDir } from "../helpers";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

let tempDir: string | undefined;

// These suites all configure a custom embeddingModel in .mimirs/config.json,
// which is now gated behind an explicit opt-in (a cloned repo's config is
// untrusted). Opt in for the whole file — see embedding-model-gate.test.ts for
// the gate behavior itself.
beforeAll(() => {
  process.env.MIMIRS_ALLOW_CUSTOM_MODEL = "1";
});
afterAll(() => {
  delete process.env.MIMIRS_ALLOW_CUSTOM_MODEL;
});

afterEach(async () => {
  // Restore the global embedder so other suites see the default dim.
  configureEmbedder(DEFAULT_MODEL_ID, DEFAULT_EMBEDDING_DIM);
  if (tempDir) {
    await cleanupTempDir(tempDir);
    tempDir = undefined;
  }
});

function rawDb(d: RagDB): import("bun:sqlite").Database {
  return (d as unknown as { db: import("bun:sqlite").Database }).db;
}

function writeConfig(dir: string, cfg: Record<string, unknown>): void {
  mkdirSync(join(dir, ".mimirs"), { recursive: true });
  writeFileSync(join(dir, ".mimirs", "config.json"), JSON.stringify(cfg, null, 2));
}

function blob(dim: number): Uint8Array {
  return new Uint8Array(new Float32Array(dim).buffer);
}

describe("RagDB embedding dim is correct by construction", () => {
  test("vec tables are created at the configured dim, not the default 384", async () => {
    tempDir = await createTempDir();
    writeConfig(tempDir, { embeddingModel: "test/model-512", embeddingDim: 512 });

    const db = new RagDB(tempDir);
    const raw = rawDb(db);

    // A 512-dim vector inserts cleanly into the table built by the constructor...
    expect(() =>
      raw.run("INSERT INTO vec_chunks (chunk_id, embedding) VALUES (1, ?)", [blob(512)]),
    ).not.toThrow();

    // ...but the old 384 default is now rejected by the table's declared dim.
    expect(() =>
      raw.run("INSERT INTO vec_chunks (chunk_id, embedding) VALUES (2, ?)", [blob(384)]),
    ).toThrow();

    db.close();
  });

  test("reopening with a mismatched configured dim throws a clear error", async () => {
    tempDir = await createTempDir();
    writeConfig(tempDir, { embeddingModel: "test/model-512", embeddingDim: 512 });
    const db1 = new RagDB(tempDir);
    db1.close();

    // Change the configured dim and reopen — must fail loudly, never silently
    // keep the old table and corrupt on insert.
    writeConfig(tempDir, { embeddingModel: "test/model-768", embeddingDim: 768 });
    expect(() => new RagDB(tempDir)).toThrow(/dimension mismatch/i);
  });

  test("a fresh project with no config uses the default dim", async () => {
    tempDir = await createTempDir();
    const db = new RagDB(tempDir);
    const raw = rawDb(db);
    expect(() =>
      raw.run("INSERT INTO vec_chunks (chunk_id, embedding) VALUES (1, ?)", [blob(DEFAULT_EMBEDDING_DIM)]),
    ).not.toThrow();
    db.close();
  });
});

describe("RagDB embedding model is checked, not just dim", () => {
  test("reopening with a different model at the SAME dim throws", async () => {
    tempDir = await createTempDir();
    writeConfig(tempDir, { embeddingModel: "test/model-A", embeddingDim: 384 });
    const db1 = new RagDB(tempDir);
    db1.close();

    // Same dim 384, different model — the dim guard can't catch this, but two
    // models at the same dim are incompatible, so it must fail loudly.
    writeConfig(tempDir, { embeddingModel: "test/model-B", embeddingDim: 384 });
    expect(() => new RagDB(tempDir)).toThrow(/model mismatch/i);
  });

  test("reopening with the same model does not throw", async () => {
    tempDir = await createTempDir();
    writeConfig(tempDir, { embeddingModel: "test/model-A", embeddingDim: 384 });
    new RagDB(tempDir).close();
    expect(() => {
      const d = new RagDB(tempDir);
      d.close();
    }).not.toThrow();
  });

  test("a legacy index with no recorded model is grandfathered (no throw)", async () => {
    tempDir = await createTempDir();
    writeConfig(tempDir, { embeddingModel: "test/model-A", embeddingDim: 384 });
    const db1 = new RagDB(tempDir);
    // Simulate a pre-meta index: erase the recorded model.
    rawDb(db1).run("DROP TABLE IF EXISTS meta");
    db1.close();

    // The original model is now unknown, so a different model must be tolerated.
    writeConfig(tempDir, { embeddingModel: "test/model-B", embeddingDim: 384 });
    expect(() => {
      const d = new RagDB(tempDir);
      d.close();
    }).not.toThrow();
  });
});

describe("RagDB embedding variant (pooling/dtype) is checked", () => {
  test("reopening with a different pooling at the same model+dim throws", async () => {
    tempDir = await createTempDir();
    writeConfig(tempDir, { embeddingModel: "test/model-A", embeddingDim: 384, embeddingPooling: "mean" });
    new RagDB(tempDir).close();

    // Same model + dim, different pooling — changes the vector space, so it must
    // fail loudly even though the model and dim guards both pass.
    writeConfig(tempDir, { embeddingModel: "test/model-A", embeddingDim: 384, embeddingPooling: "cls" });
    expect(() => new RagDB(tempDir)).toThrow(/variant mismatch/i);
  });

  test("a legacy index with no recorded variant is grandfathered (no throw)", async () => {
    tempDir = await createTempDir();
    writeConfig(tempDir, { embeddingModel: "test/model-A", embeddingDim: 384, embeddingPooling: "mean" });
    const db1 = new RagDB(tempDir);
    // Simulate a pre-variant index: erase only the recorded variant.
    rawDb(db1).run("DELETE FROM meta WHERE key = 'embedding_variant'");
    db1.close();

    writeConfig(tempDir, { embeddingModel: "test/model-A", embeddingDim: 384, embeddingPooling: "cls" });
    expect(() => {
      const d = new RagDB(tempDir);
      d.close();
    }).not.toThrow();
  });
});

describe("query embedder follows the index dim, not the validated config", () => {
  test("applyEmbeddingConfigFromDisk keeps a custom dim even when config validation fails", async () => {
    tempDir = await createTempDir();
    // Valid embeddingDim, but an invalid field (chunkOverlap >= chunkSize) makes
    // loadConfig fall back to all defaults (dim 384). The disk read used to
    // configure the query embedder must still honor 512 to match the index —
    // otherwise a cached MCP getDB embeds queries at the wrong dimension.
    writeConfig(tempDir, { embeddingModel: "test/model-512", embeddingDim: 512, chunkSize: 100, chunkOverlap: 100 });
    applyEmbeddingConfigFromDisk(tempDir);
    expect(getEmbeddingDim()).toBe(512);
  });
});
