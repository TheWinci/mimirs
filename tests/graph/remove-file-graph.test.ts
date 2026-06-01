import { describe, test, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { indexDirectory } from "../../src/indexing/indexer";
import { RagDB } from "../../src/db";
import { getEmbedder } from "../../src/embeddings/embed";
import { createTempDir, cleanupTempDir, writeFixture } from "../helpers";
import type { RagConfig } from "../../src/config";
import { join } from "path";

let tempDir: string;
let db: RagDB;

const tsConfig: RagConfig = {
  include: ["**/*.ts"],
  exclude: ["node_modules/**", ".git/**", ".mimirs/**"],
  chunkSize: 2048,
  chunkOverlap: 50,
};

beforeAll(async () => {
  await getEmbedder();
});

beforeEach(async () => {
  tempDir = await createTempDir();
  db = new RagDB(tempDir);
});

afterEach(async () => {
  db.close();
  await cleanupTempDir(tempDir);
});

function rawDb(d: RagDB): import("bun:sqlite").Database {
  return (d as unknown as { db: import("bun:sqlite").Database }).db;
}

function countOrphans(d: RagDB, table: string): number {
  return (
    rawDb(d)
      .query<{ n: number }, []>(
        `SELECT COUNT(*) AS n FROM ${table} WHERE file_id NOT IN (SELECT id FROM files)`,
      )
      .get()!.n
  );
}

describe("removeFile graph cleanup", () => {
  // PRAGMA foreign_keys is OFF, so the schema's ON DELETE CASCADE / SET NULL
  // clauses never fire. removeFile must clean graph rows by hand; this guards
  // against a regression that would leave orphaned imports/exports/refs and
  // stale cross-file resolved_* pointers (corrupting depends_on / usages).
  test("removing a file deletes its graph rows and nulls cross-file pointers", async () => {
    await writeFixture(
      tempDir,
      "def.ts",
      `export function getDB(path: string) {
  return { path };
}
`,
    );
    await writeFixture(
      tempDir,
      "use.ts",
      `import { getDB } from "./def";

export function initServer() {
  return getDB("./data.db");
}
`,
    );

    await indexDirectory(tempDir, db, tsConfig);

    // indexDirectory stores files by absolute (normalized) path.
    const defPath = join(tempDir, "def.ts");
    const usePath = join(tempDir, "use.ts");
    const defFile = db.getFileByPath(defPath);
    const useFile = db.getFileByPath(usePath);
    expect(defFile).not.toBeNull();
    expect(useFile).not.toBeNull();

    // Sanity: use.ts's import of getDB resolved to def.ts before removal.
    const resolvedImportBefore = rawDb(db)
      .query<{ n: number }, [number, number]>(
        "SELECT COUNT(*) AS n FROM file_imports WHERE file_id = ? AND resolved_file_id = ?",
      )
      .get(useFile!.id, defFile!.id)!.n;
    expect(resolvedImportBefore).toBeGreaterThan(0);

    // def.ts owns graph rows before removal.
    expect(
      rawDb(db)
        .query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM file_exports WHERE file_id = ?")
        .get(defFile!.id)!.n,
    ).toBeGreaterThan(0);

    const removed = db.removeFile(defPath);
    expect(removed).toBe(true);

    // No orphaned rows pointing at a now-deleted file id.
    expect(countOrphans(db, "file_imports")).toBe(0);
    expect(countOrphans(db, "file_exports")).toBe(0);
    expect(countOrphans(db, "symbol_refs")).toBe(0);

    // Cross-file pointers AT def.ts are nulled, not left dangling.
    const danglingImport = rawDb(db)
      .query<{ n: number }, [number]>(
        "SELECT COUNT(*) AS n FROM file_imports WHERE resolved_file_id = ?",
      )
      .get(defFile!.id)!.n;
    expect(danglingImport).toBe(0);

    const danglingRef = rawDb(db)
      .query<{ n: number }, [number]>(
        "SELECT COUNT(*) AS n FROM symbol_refs WHERE resolved_export_id IN (SELECT id FROM file_exports WHERE file_id = ?)",
      )
      .get(defFile!.id)!.n;
    expect(danglingRef).toBe(0);

    // use.ts survives and its rows are intact.
    expect(db.getFileByPath(usePath)).not.toBeNull();
  });
});
