import { describe, test, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { RagDB } from "../../src/db";
import { getEmbedder } from "../../src/embeddings/embed";
import { createTempDir, cleanupTempDir, writeFixture } from "../helpers";
import { indexDirectory } from "../../src/indexing/indexer";
import { splitIdentifier, identifierParts } from "../../src/indexing/identifiers";
import type { RagConfig } from "../../src/config";

describe("identifier splitting", () => {
  test("splits camelCase / snake_case / acronyms, lowercased", () => {
    expect(splitIdentifier("getDependsOn")).toEqual(["get", "depends", "on"]);
    expect(splitIdentifier("content_hash")).toEqual(["content", "hash"]);
    expect(splitIdentifier("HTMLParser")).toEqual(["html", "parser"]);
  });

  test("identifierParts emits compound parts but not plain words", () => {
    expect(identifierParts("function getDependsOn() {}").split(" ")).toContain("depends");
    expect(identifierParts("just plain words here")).toBe(""); // single words already in snippet
  });

  test("caps absurdly long tokens (blob guard, no quadratic blowup)", () => {
    // A long uppercase run (base64/hex blob) inside a normal-line file is one
    // giant token. The case-boundary regex is O(n²), so without a cap this hangs.
    const code = `const DATA = "${"A".repeat(40000)}";`;
    const t0 = performance.now();
    const parts = identifierParts(code);
    const dt = performance.now() - t0;
    expect(parts).toBe(""); // the blob token is skipped; const/DATA aren't compound
    expect(dt).toBeLessThan(100); // unclamped this token alone is ~1s
  });
});

const config: RagConfig = {
  include: ["**/*.ts"],
  exclude: ["node_modules/**", ".git/**", ".mimirs/**"],
  chunkSize: 512,
  chunkOverlap: 50,
  hybridWeight: 0.5,
  searchTopK: 5,
  benchmarkTopK: 5,
  benchmarkMinRecall: 0.8,
  benchmarkMinMrr: 0.6,
};

describe("identifier-aware FTS", () => {
  let tempDir: string;
  let db: RagDB;

  beforeAll(async () => { await getEmbedder(); });
  beforeEach(async () => { tempDir = await createTempDir(); db = new RagDB(tempDir); });
  afterEach(async () => { db.close(); await cleanupTempDir(tempDir); });

  test("a word-part query finds the compound identifier (was invisible before)", async () => {
    await writeFixture(tempDir, "graph.ts", `
export function getDependsOn(fileId: number): string[] {
  return resolveDependencyEdges(fileId);
}
`);
    await indexDirectory(tempDir, db, config);

    // Assert on db.textSearch (the raw FTS path) — NOT search(), whose vector
    // candidates would find graph.ts semantically regardless and mask the
    // tokenizer behaviour. "depends" matches only because getDependsOn's parts
    // are indexed, even though the literal token is "getDependsOn".
    const hits = db.textSearch("depends", 20);
    expect(hits.some((r) => r.path.includes("graph.ts"))).toBe(true);
  });
});
