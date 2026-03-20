import { describe, test, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { RagDB } from "../../src/db";
import { embed, getEmbedder } from "../../src/embeddings/embed";
import { createTempDir, cleanupTempDir } from "../helpers";

let tempDir: string;
let db: RagDB;

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

describe("upsert and retrieval", () => {
  test("saves an annotation and retrieves it by path", async () => {
    const emb = await embed("RagDB constructor is not thread-safe");
    const id = db.upsertAnnotation("src/db.ts", "RagDB constructor is not thread-safe", emb, "RagDB", "agent");

    const results = db.getAnnotations("src/db.ts");
    expect(results.length).toBe(1);
    expect(results[0].id).toBe(id);
    expect(results[0].note).toBe("RagDB constructor is not thread-safe");
    expect(results[0].symbolName).toBe("RagDB");
    expect(results[0].author).toBe("agent");
  });

  test("retrieves all annotations for a file regardless of symbol", async () => {
    const emb1 = await embed("note one");
    const emb2 = await embed("note two");
    db.upsertAnnotation("src/db.ts", "note one", emb1, "FunctionA");
    db.upsertAnnotation("src/db.ts", "note two", emb2, "FunctionB");

    const results = db.getAnnotations("src/db.ts");
    expect(results.length).toBe(2);
  });

  test("returns empty array when no annotations exist for path", async () => {
    const results = db.getAnnotations("nonexistent.ts");
    expect(results).toEqual([]);
  });

  test("filters by symbol name", async () => {
    const emb1 = await embed("for alpha");
    const emb2 = await embed("for beta");
    db.upsertAnnotation("src/mod.ts", "for alpha", emb1, "alpha");
    db.upsertAnnotation("src/mod.ts", "for beta", emb2, "beta");

    const results = db.getAnnotations("src/mod.ts", "alpha");
    expect(results.length).toBe(1);
    expect(results[0].symbolName).toBe("alpha");
  });
});

describe("upsert updates existing annotation", () => {
  test("calling annotate again on same (path, symbol) updates rather than duplicates", async () => {
    const emb1 = await embed("initial note");
    const emb2 = await embed("updated note");

    db.upsertAnnotation("src/db.ts", "initial note", emb1, "RagDB");
    db.upsertAnnotation("src/db.ts", "updated note", emb2, "RagDB");

    const results = db.getAnnotations("src/db.ts", "RagDB");
    expect(results.length).toBe(1);
    expect(results[0].note).toBe("updated note");
  });

  test("file-level annotation (no symbol) also deduplicates", async () => {
    const emb1 = await embed("first file note");
    const emb2 = await embed("second file note");

    db.upsertAnnotation("src/config.ts", "first file note", emb1);
    db.upsertAnnotation("src/config.ts", "second file note", emb2);

    const results = db.getAnnotations("src/config.ts", null);
    expect(results.length).toBe(1);
    expect(results[0].note).toBe("second file note");
  });
});

describe("semantic search over annotations", () => {
  test("searchAnnotations finds annotation by semantic similarity", async () => {
    const note = "avoid concurrent writes to this table";
    const emb = await embed(note);
    db.upsertAnnotation("src/db.ts", note, emb, "RagDB");

    const queryEmb = await embed("thread safety concurrency");
    const results = db.searchAnnotations(queryEmb, 5);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].path).toBe("src/db.ts");
    expect(results[0].score).toBeGreaterThan(0);
  });

  test("returns empty when no annotations exist", async () => {
    const queryEmb = await embed("anything");
    const results = db.searchAnnotations(queryEmb, 5);
    expect(results).toEqual([]);
  });
});

describe("deleteAnnotation", () => {
  test("removes annotation and returns true", async () => {
    const emb = await embed("temporary note");
    const id = db.upsertAnnotation("src/x.ts", "temporary note", emb);

    const deleted = db.deleteAnnotation(id);
    expect(deleted).toBe(true);

    const remaining = db.getAnnotations("src/x.ts");
    expect(remaining).toEqual([]);
  });

  test("returns false for non-existent id", async () => {
    const deleted = db.deleteAnnotation(9999);
    expect(deleted).toBe(false);
  });
});

describe("annotations survive re-indexing", () => {
  test("annotations in separate table are unaffected by file re-index", async () => {
    const emb = await embed("persistent note");
    db.upsertAnnotation("src/stable.ts", "persistent note", emb, "stableFunc");

    // Simulate re-indexing the file (upsertFile replaces chunks but not annotations)
    const fileEmb = await embed("export function stableFunc() {}");
    db.upsertFile("src/stable.ts", "new-hash", [{ snippet: "export function stableFunc() {}", embedding: fileEmb }]);

    const annotations = db.getAnnotations("src/stable.ts");
    expect(annotations.length).toBe(1);
    expect(annotations[0].note).toBe("persistent note");
  });
});
