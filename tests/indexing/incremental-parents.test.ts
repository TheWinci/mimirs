import { describe, test, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { indexDirectory } from "../../src/indexing/indexer";
import { RagDB } from "../../src/db";
import { getEmbedder } from "../../src/embeddings/embed";
import { createTempDir, cleanupTempDir, writeFixture } from "../helpers";
import type { RagConfig } from "../../src/config";

let tempDir: string;
let db: RagDB;

// incrementalChunks is the opt-in path under test.
const config: RagConfig = {
  include: ["**/*.ts"],
  exclude: ["node_modules/**", ".git/**", ".mimirs/**"],
  chunkSize: 512,
  chunkOverlap: 50,
  incrementalChunks: true,
};

// A class big enough that bun-chunk splits it into per-method children + one
// parent chunk (verified: n=30/body=10/chunkSize=512 -> 1 parent).
function makeClass(editMarker: string): string {
  const methods = Array.from({ length: 30 }, (_, i) => {
    const extra = i === 0 ? `    const marker = "${editMarker}";\n` : "";
    const body = Array.from({ length: 10 }, (_, k) =>
      `    const v${k} = this.compute(${i}, ${k}) + Math.sqrt(${k}) * ${i}; total += v${k};`,
    ).join("\n");
    return `  method${i}(): number {\n    let total = 0;\n${extra}${body}\n    return total;\n  }`;
  }).join("\n\n");
  return `export class BigWidget {\n  compute(a: number, b: number): number { return a + b; }\n\n${methods}\n}\n`;
}

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

function parentCount(d: RagDB): number {
  return rawDb(d).query<{ n: number }, []>("SELECT COUNT(*) n FROM chunks WHERE chunk_index = -1").get()!.n;
}

function danglingParentRefs(d: RagDB): number {
  return rawDb(d)
    .query<{ n: number }, []>(
      "SELECT COUNT(*) n FROM chunks WHERE parent_id IS NOT NULL AND parent_id NOT IN (SELECT id FROM chunks)",
    )
    .get()!.n;
}

/** Number of (file_id, chunk_index) groups that have more than one row. */
function indexCollisions(d: RagDB): number {
  return rawDb(d)
    .query<{ n: number }, []>(
      `SELECT COUNT(*) AS n FROM (
         SELECT file_id, chunk_index FROM chunks WHERE chunk_index >= 0
         GROUP BY file_id, chunk_index HAVING COUNT(*) > 1)`,
    )
    .get()!.n;
}

describe("B1: incremental re-index preserves parent chunks", () => {
  test("editing one method keeps the parent chunk and leaves no dangling refs", async () => {
    await writeFixture(tempDir, "widget.ts", makeClass("ORIGINAL"));
    await indexDirectory(tempDir, db, config);

    // Precondition: indexing produced a parent chunk with no dangling refs.
    expect(parentCount(db)).toBe(1);
    expect(danglingParentRefs(db)).toBe(0);

    // Edit one method's body (a small change → incremental path is taken).
    await writeFixture(tempDir, "widget.ts", makeClass("EDITED_MARKER_42"));
    await indexDirectory(tempDir, db, config);

    // The parent must still exist (rebuilt), and no child may point at a
    // deleted parent. Before the fix this returned parents=0, dangling>0.
    expect(parentCount(db)).toBe(1);
    expect(danglingParentRefs(db)).toBe(0);

    // The rebuilt parent reflects the edit.
    const parentSnippet = rawDb(db)
      .query<{ snippet: string }, []>("SELECT snippet FROM chunks WHERE chunk_index = -1 LIMIT 1")
      .get()!.snippet;
    expect(parentSnippet).toContain("EDITED_MARKER_42");
  });

  test("a file with no parent groups still uses the incremental path", async () => {
    // Independent top-level functions → separate chunks, no parent grouping.
    const fns = (marker: string) =>
      Array.from({ length: 12 }, (_, i) => {
        const tag = i === 3 ? ` // ${marker}` : "";
        return `export function fn${i}(x: number): number {${tag}\n  return x * ${i} + ${i};\n}`;
      }).join("\n\n");

    await writeFixture(tempDir, "fns.ts", fns("ORIGINAL"));
    await indexDirectory(tempDir, db, config);
    expect(parentCount(db)).toBe(0); // precondition: no parent groups here

    // Edit one function and capture progress to confirm the incremental branch ran.
    const messages: string[] = [];
    await writeFixture(tempDir, "fns.ts", fns("INCREMENTAL_TAG"));
    await indexDirectory(tempDir, db, config, (m) => messages.push(m));

    expect(messages.some((m) => m.includes("Incremental update"))).toBe(true);
    expect(danglingParentRefs(db)).toBe(0);

    // The edited content replaced the old chunk.
    const hasNew = rawDb(db)
      .query<{ n: number }, []>("SELECT COUNT(*) n FROM chunks WHERE snippet LIKE '%INCREMENTAL_TAG%'")
      .get()!.n;
    const hasOld = rawDb(db)
      .query<{ n: number }, []>("SELECT COUNT(*) n FROM chunks WHERE snippet LIKE '%ORIGINAL%'")
      .get()!.n;
    expect(hasNew).toBeGreaterThan(0);
    expect(hasOld).toBe(0);
  });
});

describe("incremental fallback guards", () => {
  // bun-chunk hashes by content, so identical-text chunks share a hash. The
  // incremental position update keys by content_hash, so without a guard it
  // assigns every duplicate the last chunk_index → collisions.
  test("duplicate-content chunks defer to a full re-index (no chunk_index collision)", async () => {
    const dupConfig: RagConfig = { ...config, chunkSize: 256, chunkOverlap: 20 };
    const fn = `export function doThing(x: number): number {\n  let total = 0;\n  total += x * 2;\n  total += x * 3;\n  return total;\n}`;
    const pad = (i: number, marker = "") => `export function uniq${i}(x: number) { return x + ${i};${marker} }`;
    const file = (marker: string) =>
      [fn, pad(1), fn, pad(2, marker), fn, pad(3), pad(4), pad(5)].join("\n\n") + "\n";

    await writeFixture(tempDir, "dups.ts", file(""));
    await indexDirectory(tempDir, db, dupConfig); // first index is full
    expect(indexCollisions(db)).toBe(0);

    // Small edit to one unique fn → incremental is attempted, but duplicate
    // hashes must force a full re-index instead of corrupting chunk_index.
    await writeFixture(tempDir, "dups.ts", file(" /* edited */"));
    await indexDirectory(tempDir, db, dupConfig);
    expect(indexCollisions(db)).toBe(0); // was >0 before the guard
  });

  test("fileHasParentChunks reflects whether the index holds parent rows", async () => {
    await writeFixture(tempDir, "widget.ts", makeClass("ORIGINAL"));
    await writeFixture(tempDir, "plain.ts", "export const a = 1;\nexport const b = 2;\n");
    await indexDirectory(tempDir, db, config);

    const widget = db.getFileByPath(`${tempDir}/widget.ts`)!;
    const plain = db.getFileByPath(`${tempDir}/plain.ts`)!;
    expect(db.fileHasParentChunks(widget.id)).toBe(true);
    expect(db.fileHasParentChunks(plain.id)).toBe(false);
  });
});
