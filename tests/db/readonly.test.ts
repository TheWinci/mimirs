import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "path";
import { createTempDir, cleanupTempDir } from "../helpers";
import { RagDB, SCHEMA_VERSION } from "../../src/db";

let tempDir: string;
const open: RagDB[] = [];

beforeEach(async () => {
  tempDir = await createTempDir();
});

afterEach(async () => {
  for (const db of open.splice(0)) {
    try { db.close(); } catch { /* already closed */ }
  }
  await cleanupTempDir(tempDir);
});

/** Create a real index DB the writable way, then close it — the foreign repo
 * whose .mimirs we attach to. */
function buildIndex(dir: string): void {
  const db = new RagDB(dir);
  db.close();
}

describe("readonly attach (connect_repo / cross-repo queries)", () => {
  test("opens an existing index and serves reads", () => {
    buildIndex(tempDir);
    const db = new RagDB(tempDir, undefined, { readonly: true });
    open.push(db);

    expect(db.isReadonly).toBe(true);
    const status = db.getStatus();
    expect(status.totalFiles).toBe(0);
    expect(status.totalChunks).toBe(0);
  });

  test("rejects writes instead of mutating a foreign index", () => {
    buildIndex(tempDir);
    const db = new RagDB(tempDir, undefined, { readonly: true });
    open.push(db);

    expect(() => db.setGitResumePoint("abc123")).toThrow(/readonly/i);
  });

  test("refuses to scaffold: missing index.db throws instead of creating one", () => {
    expect(() => new RagDB(tempDir, undefined, { readonly: true }))
      .toThrow(/No mimirs index/);
  });

  test("newer schema version warns but still serves reads", () => {
    buildIndex(tempDir);
    const raw = new Database(join(tempDir, ".mimirs", "index.db"));
    raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 10}`);
    raw.close();

    const db = new RagDB(tempDir, undefined, { readonly: true });
    open.push(db);
    expect(db.getStatus().totalFiles).toBe(0);
  });

  test("does not bump the foreign schema stamp", () => {
    buildIndex(tempDir);
    const dbPath = join(tempDir, ".mimirs", "index.db");
    const before = new Database(dbPath);
    before.exec("PRAGMA user_version = 0"); // simulate pre-stamp foreign index
    before.close();

    const db = new RagDB(tempDir, undefined, { readonly: true });
    open.push(db);
    db.getStatus();
    db.close();

    const after = new Database(dbPath);
    const stored = after.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version;
    after.close();
    expect(stored).toBe(0); // a writable open would have re-stamped it
  });
});
