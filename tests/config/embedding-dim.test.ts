import { describe, test, expect, afterEach } from "bun:test";
import { RagDB } from "../../src/db";
import { configureEmbedder, DEFAULT_MODEL_ID, DEFAULT_EMBEDDING_DIM } from "../../src/embeddings/embed";
import { createTempDir, cleanupTempDir } from "../helpers";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

let tempDir: string | undefined;

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
