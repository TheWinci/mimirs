import { describe, test, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { RagDB } from "../../src/db";
import { getEmbedder, embedBatch } from "../../src/embeddings/embed";
import { createTempDir, cleanupTempDir, writeFixture } from "../helpers";
import { indexDirectory } from "../../src/indexing/indexer";
import { search, searchChunks } from "../../src/search/hybrid";
import type { RagConfig } from "../../src/config";

let tempDir: string;
let db: RagDB;

const config: RagConfig = {
  include: ["**/*.ts", "**/*.md"],
  exclude: ["node_modules/**", ".git/**", ".mimirs/**"],
  chunkSize: 512,
  chunkOverlap: 50,
  hybridWeight: 0.7,
  searchTopK: 5,
  benchmarkTopK: 5,
  benchmarkMinRecall: 0.8,
  benchmarkMinMrr: 0.6,
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

describe("FTS special character handling", () => {
  test("queries with FTS operators do not throw", async () => {
    // Index a file with content that contains special chars
    await writeFixture(tempDir, "special.ts", `
// Support for c++ interop
export function nodeDotJs() {
  return "node.js runtime";
}

// SELECT * FROM users WHERE active = true
export const SQL_QUERY = "SELECT * FROM users";

// Uses AND, OR, NOT operators
export function booleanLogic(a: boolean, b: boolean) {
  return (a AND b) OR NOT a;
}
`);

    await indexDirectory(tempDir, db, config);

    // These queries contain FTS5 operators that would crash without sanitization
    const specialQueries = [
      "c++",
      "node.js",
      'SELECT * FROM users',
      "AND OR NOT",
      '"quoted phrase"',
      "NEAR(a, b)",
      "test + something",
      "hello-world",
      "(parentheses)",
      "asterisk*",
    ];

    for (const query of specialQueries) {
      // Should not throw — may return 0 results, that's fine
      const results = await search(query, db, 5, 0, 0.7);
      expect(Array.isArray(results)).toBe(true);

      const chunkResults = await searchChunks(query, db, 5, 0, 0.7);
      expect(Array.isArray(chunkResults)).toBe(true);
    }

    // Positive-match: queries for known content should return the indexed file
    const nodeResults = await search("node.js runtime", db, 5, 0, 0.7);
    expect(nodeResults.length).toBeGreaterThan(0);
    expect(nodeResults[0].path).toContain("special.ts");

    const sqlResults = await searchChunks("SELECT FROM users", db, 5, 0, 0.7);
    expect(sqlResults.length).toBeGreaterThan(0);
    expect(sqlResults[0].path).toContain("special.ts");
  });

  test("text search on conversation does not throw with special chars", async () => {
    // textSearchConversation uses FTS too — verify it's sanitized
    const specialQueries = ["c++", "node.js", "AND OR NOT"];

    for (const query of specialQueries) {
      // Should not throw even with empty conversation index
      const results = db.textSearchConversation(query, 5);
      expect(Array.isArray(results)).toBe(true);
    }
  });
});
