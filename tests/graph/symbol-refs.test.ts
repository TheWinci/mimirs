import { describe, test, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { indexDirectory } from "../../src/indexing/indexer";
import { RagDB } from "../../src/db";
import { getEmbedder } from "../../src/embeddings/embed";
import { createTempDir, cleanupTempDir, writeFixture } from "../helpers";
import type { RagConfig } from "../../src/config";

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

describe("symbol_refs end-to-end", () => {
  test("populates symbol_refs from indexed TS files", async () => {
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
  const database = getDB("./data.db");
  return database;
}
`,
    );

    await indexDirectory(tempDir, db, tsConfig);

    const refRows = rawDb(db)
      .query<{ name: string; line: number; resolved_export_id: number | null; path: string }, []>(
        `SELECT sr.name, sr.line, sr.resolved_export_id, f.path
         FROM symbol_refs sr
         JOIN files f ON f.id = sr.file_id`,
      )
      .all();

    expect(refRows.length).toBeGreaterThan(0);

    // Should see `getDB` referenced from use.ts (call site).
    const getDBFromUse = refRows.filter(
      (r) => r.name === "getDB" && r.path.endsWith("use.ts"),
    );
    expect(getDBFromUse.length).toBeGreaterThanOrEqual(1);

    // Resolution should have linked at least one of those refs to def.ts's
    // exported `getDB`. `resolved_export_id` is non-null for resolved refs.
    const resolved = getDBFromUse.find((r) => r.resolved_export_id != null);
    expect(resolved).toBeDefined();
  });

  test("findUsages returns the symbol_refs row for a cross-file call", async () => {
    await writeFixture(
      tempDir,
      "def.ts",
      `export function ping() {
  return 1;
}
`,
    );
    await writeFixture(
      tempDir,
      "use.ts",
      `import { ping } from "./def";

export function caller() {
  return ping();
}
`,
    );

    await indexDirectory(tempDir, db, tsConfig);

    const usages = db.findUsages("ping", true, 10);
    const useHit = usages.find((u) => u.path.endsWith("use.ts"));
    expect(useHit).toBeDefined();
    // Should NOT include the defining file.
    expect(usages.some((u) => u.path.endsWith("def.ts"))).toBe(false);
  });

  test("resolves namespace member access (import * as ns; ns.foo())", async () => {
    await writeFixture(
      tempDir,
      "store.ts",
      `export function upsertRow(id: number) {
  return id;
}
`,
    );
    await writeFixture(
      tempDir,
      "wrap.ts",
      `import * as store from "./store";

export function save(id: number) {
  return store.upsertRow(id);
}
`,
    );

    await indexDirectory(tempDir, db, tsConfig);

    const refs = rawDb(db)
      .query<{ name: string; resolved_export_id: number | null; path: string }, []>(
        `SELECT sr.name, sr.resolved_export_id, f.path
         FROM symbol_refs sr
         JOIN files f ON f.id = sr.file_id`,
      )
      .all();

    const memberRef = refs.find(
      (r) => r.name === "upsertRow" && r.path.endsWith("wrap.ts"),
    );
    expect(memberRef).toBeDefined();
    expect(memberRef!.resolved_export_id).not.toBeNull();

    const usages = db.findUsages("upsertRow", true, 10);
    expect(usages.some((u) => u.path.endsWith("wrap.ts"))).toBe(true);
    expect(usages.some((u) => u.path.endsWith("store.ts"))).toBe(false);
  });

  test("resolves same-file exported callable refs and counts them as inbound", async () => {
    await writeFixture(
      tempDir,
      "manifest.ts",
      `export function buildManifest(entry: { kind: string }) {
  return entrySlug(entry);
}

export function entrySlug(entry: { kind: string }) {
  switch (entry.kind) {
    case "tool":
      return "tool";
    default:
      return "entry";
  }
}
`,
    );

    await indexDirectory(tempDir, db, tsConfig);
    const rows = rawDb(db)
      .query<{ name: string; resolved_export_id: number | null; line: number }, []>(
        `SELECT name, resolved_export_id, line
         FROM symbol_refs
         WHERE name = 'entrySlug'`,
      )
      .all();
    const callRef = rows.find((r) => r.line === 1);
    expect(callRef?.resolved_export_id).not.toBeNull();

    const entrySlugExport = db.getCallableExports().find((ex) => ex.name === "entrySlug");
    expect(entrySlugExport).toBeDefined();
    const inbound = db.countInboundRefsByExport(new Set());
    expect(inbound.get(entrySlugExport!.exportId)).toBeGreaterThanOrEqual(1);
  });

  test("re-export ancestors do not pollute symbol_refs", async () => {
    await writeFixture(
      tempDir,
      "core.ts",
      `export function helperX() {
  return 42;
}
`,
    );
    // Barrel re-export — would be a false positive in the old import-edge
    // scheme but bun-chunk's reference query skips export ancestors.
    await writeFixture(
      tempDir,
      "index.ts",
      `export { helperX } from "./core";
`,
    );

    await indexDirectory(tempDir, db, tsConfig);

    const refsToHelperX = rawDb(db)
      .query<{ path: string }, [string]>(
        `SELECT f.path FROM symbol_refs sr
         JOIN files f ON f.id = sr.file_id
         WHERE sr.name = ?`,
      )
      .all("helperX");

    // index.ts's `helperX` mention is inside the export statement and must
    // be filtered out by bun-chunk's ancestor filter.
    expect(refsToHelperX.some((r) => r.path.endsWith("index.ts"))).toBe(false);
  });
});
