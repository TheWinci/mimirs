import { describe, test, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { indexDirectory, indexFile } from "../../src/indexing/indexer";
import { RagDB } from "../../src/db";
import { getEmbedder } from "../../src/embeddings/embed";
import { createTempDir, cleanupTempDir, writeFixture } from "../helpers";
import type { RagConfig } from "../../src/config";

let tempDir: string;
let db: RagDB;

const tsConfig: RagConfig = {
  include: ["**/*.ts"],
  exclude: ["node_modules/**", ".git/**", ".mimirs/**"],
  chunkSize: 512,
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

describe("line numbers in indexed chunks", () => {
  test("start_line and end_line are non-null after indexing a TS file", async () => {
    await writeFixture(
      tempDir,
      "example.ts",
      `export function hello(): string {
  return "hello";
}

export function world(): string {
  return "world";
}
`
    );

    await indexDirectory(tempDir, db, tsConfig);

    const emb = (await import("../../src/embeddings/embed")).embed;
    const queryEmb = await emb("hello function");
    const results = db.searchChunks(queryEmb, 5);

    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.startLine).not.toBeNull();
      expect(r.endLine).not.toBeNull();
      expect(r.startLine).toBeGreaterThanOrEqual(1);
      expect(r.endLine).toBeGreaterThanOrEqual(r.startLine!);
    }
  });

  test("line range for first function starts near line 1", async () => {
    await writeFixture(
      tempDir,
      "fn.ts",
      `export function first(): void {
  console.log("first");
}

export function second(): void {
  console.log("second");
}
`
    );

    await indexDirectory(tempDir, db, tsConfig);

    const emb = (await import("../../src/embeddings/embed")).embed;
    const queryEmb = await emb("first function console log");
    const results = db.searchChunks(queryEmb, 10);

    const firstFnChunk = results.find(
      (r) => r.entityName === "first" || (r.content && r.content.includes("first"))
    );
    expect(firstFnChunk).toBeDefined();
    expect(firstFnChunk!.startLine).toBe(1);
  });

  test("chunks without line numbers stored degrade gracefully", async () => {
    // Seed a chunk with no line numbers directly — simulates old rows
    const { embed } = await import("../../src/embeddings/embed");
    const emb = await embed("some content without lines");
    db.upsertFile("/old-file.ts", "hash-old", [
      { snippet: "some content without lines", embedding: emb, startLine: null, endLine: null },
    ]);

    const results = db.searchChunks(emb, 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].startLine).toBeNull();
    expect(results[0].endLine).toBeNull();
  });

  test("line numbers survive a re-index", async () => {
    await writeFixture(
      tempDir,
      "stable.ts",
      `export function stable(): boolean {
  return true;
}
`
    );

    // Index once
    await indexDirectory(tempDir, db, tsConfig);

    const { embed } = await import("../../src/embeddings/embed");
    const queryEmb = await embed("stable function");
    const first = db.searchChunks(queryEmb, 5);
    const firstLine = first[0]?.startLine;
    expect(firstLine).not.toBeNull();

    // Force re-index by removing the file record (simulating content change)
    // Change file hash so it re-indexes
    await writeFixture(
      tempDir,
      "stable.ts",
      `// updated comment
export function stable(): boolean {
  return true;
}
`
    );
    await indexDirectory(tempDir, db, tsConfig);

    const second = db.searchChunks(queryEmb, 5);
    expect(second[0]?.startLine).not.toBeNull();
  });

  // Part 2 #5: assert line numbers actually SHIFT after an edit (the test above
  // only checked non-null, so frozen-stale line numbers would have passed).
  function startLineOf(d: RagDB, needle: string): number | null {
    const raw = (d as unknown as { db: import("bun:sqlite").Database }).db;
    return (
      raw
        .query<{ start_line: number | null }, [string]>(
          "SELECT start_line FROM chunks WHERE snippet LIKE ? AND chunk_index >= 0 ORDER BY start_line LIMIT 1",
        )
        .get(`%${needle}%`)?.start_line ?? null
    );
  }

  function manyFns(prefixComments: number, marker: string): string {
    const head = Array.from({ length: prefixComments }, (_, i) => `// header line ${i}`).join("\n");
    const fns = Array.from({ length: 8 }, (_, i) => {
      const tag = i === 5 ? ` // ${marker}` : "";
      return `export function fn${i}(x: number): number {${tag}\n  return x * ${i} + ${i};\n}`;
    }).join("\n\n");
    return (head ? head + "\n" : "") + fns + "\n";
  }

  test("full re-index updates a chunk's start_line after lines are prepended", async () => {
    await writeFixture(tempDir, "shift.ts", manyFns(0, "MARK_FULL"));
    await indexDirectory(tempDir, db, tsConfig);
    const before = startLineOf(db, "MARK_FULL");
    expect(before).not.toBeNull();

    // Prepend 4 lines; the marked function moves down by exactly 4.
    await writeFixture(tempDir, "shift.ts", manyFns(4, "MARK_FULL"));
    await indexDirectory(tempDir, db, tsConfig);

    expect(startLineOf(db, "MARK_FULL")).toBe(before! + 4);
  });

  // Class invariant: every stored line range, sliced from the REAL file, must
  // contain the chunk's text. Catches any future drift between embedding-text
  // offsets and on-disk offsets (frontmatter, trimming, transforms).
  test("markdown with frontmatter cites real file lines (round-trip invariant)", async () => {
    const md = `---
name: my-doc
description: a doc about widgets
tags: [a, b]
---

intro paragraph

# Widget Heading

widget body text
`;
    await writeFixture(tempDir, "doc.md", md);
    const mdConfig: RagConfig = { ...tsConfig, include: ["**/*.md"] };
    await indexDirectory(tempDir, db, mdConfig);

    const fileLines = md.split("\n");
    const raw = (db as unknown as { db: import("bun:sqlite").Database }).db;
    const rows = raw
      .query<{ snippet: string; start_line: number | null; end_line: number | null }, []>(
        "SELECT snippet, start_line, end_line FROM chunks WHERE chunk_index >= 0",
      )
      .all();
    expect(rows.length).toBeGreaterThan(0);

    let verified = 0;
    for (const r of rows) {
      if (r.start_line === null || r.end_line === null) continue; // synthetic chunks may opt out
      const slice = fileLines.slice(r.start_line - 1, r.end_line).join("\n");
      // The cited range must contain the chunk text (chunk may be a sub-span).
      expect(slice).toContain(r.snippet.trim().split("\n")[0]);
      verified++;
    }
    // The heading chunk must carry numbers and point at the real line (9, after
    // 5 frontmatter lines + intro) — the old code said line 1. Asserted
    // unconditionally: an `if (start_line !== null)` guard here would let a
    // regression to null line numbers pass silently.
    const heading = rows.find((r) => r.snippet.includes("# Widget Heading"));
    expect(heading).toBeDefined();
    expect(heading!.start_line).toBe(9);
    expect(verified).toBeGreaterThan(0);
  });

  test("incremental re-index updates a KEPT chunk's start_line after a shift", async () => {
    const incConfig: RagConfig = { ...tsConfig, incrementalChunks: true };
    await writeFixture(tempDir, "shift.ts", manyFns(0, "MARK_INC"));
    await indexDirectory(tempDir, db, incConfig);
    const before = startLineOf(db, "MARK_INC");
    expect(before).not.toBeNull();

    // Prepend 3 lines: the marked fn's text is unchanged (a "kept" chunk) but it
    // shifts down 3 lines. updateChunkPositions must refresh its start_line.
    const messages: string[] = [];
    await writeFixture(tempDir, "shift.ts", manyFns(3, "MARK_INC"));
    await indexDirectory(tempDir, db, incConfig, (m) => messages.push(m));

    expect(messages.some((m) => m.includes("Incremental update"))).toBe(true);
    expect(startLineOf(db, "MARK_INC")).toBe(before! + 3);
  });
});
