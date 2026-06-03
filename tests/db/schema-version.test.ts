import { describe, test, expect, afterEach } from "bun:test";
import { RagDB, SCHEMA_VERSION } from "../../src/db";
import { createTempDir, cleanupTempDir } from "../helpers";

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) {
    await cleanupTempDir(tempDir);
    tempDir = undefined;
  }
});

function rawDb(d: RagDB): import("bun:sqlite").Database {
  return (d as unknown as { db: import("bun:sqlite").Database }).db;
}

function userVersion(d: RagDB): number {
  return rawDb(d).query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
}

describe("schema version stamp (Part 2 #3)", () => {
  test("a fresh index is stamped with the current schema version", async () => {
    tempDir = await createTempDir();
    const db = new RagDB(tempDir);
    expect(userVersion(db)).toBe(SCHEMA_VERSION);
    db.close();
  });

  test("reopening is idempotent — version and data are preserved, no error", async () => {
    tempDir = await createTempDir();
    const db1 = new RagDB(tempDir);
    rawDb(db1).run("INSERT INTO files (path, hash, indexed_at) VALUES ('a.ts', 'h', '2020-01-01')");
    const before = rawDb(db1).query<{ n: number }, []>("SELECT COUNT(*) n FROM files").get()!.n;
    db1.close();

    // Reopen — re-runs initSchema + all migrations against populated data.
    const db2 = new RagDB(tempDir);
    expect(userVersion(db2)).toBe(SCHEMA_VERSION);
    expect(rawDb(db2).query<{ n: number }, []>("SELECT COUNT(*) n FROM files").get()!.n).toBe(before);
    db2.close();
  });

  test("a future-version index opens without throwing and keeps its newer stamp", async () => {
    tempDir = await createTempDir();
    const db1 = new RagDB(tempDir);
    rawDb(db1).exec(`PRAGMA user_version = ${SCHEMA_VERSION + 5}`);
    db1.close();

    let db2: RagDB | undefined;
    expect(() => {
      db2 = new RagDB(tempDir);
    }).not.toThrow();
    // The newer stamp is not downgraded.
    expect(userVersion(db2!)).toBe(SCHEMA_VERSION + 5);
    db2!.close();
  });
});
