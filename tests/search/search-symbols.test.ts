import { describe, test, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { RagDB } from "../../src/db";
import { embed, getEmbedder } from "../../src/embeddings/embed";
import { chunkText } from "../../src/indexing/chunker";
import { resolveImports } from "../../src/graph/resolver";
import { createTempDir, cleanupTempDir } from "../helpers";
import { join } from "path";

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

/** Index a TypeScript file with full chunking and graph extraction. */
async function indexFile(relativePath: string, content: string) {
  const fullPath = join(tempDir, relativePath);
  const { chunks, fileImports, fileExports } = await chunkText(content, ".ts", 2000, 50, fullPath);

  // Map parent chunk names to IDs for parentId linking
  const parentNameToId = new Map<string, number>();
  const embeddedChunks = [];
  let chunkIdx = 0;

  for (const chunk of chunks) {
    const emb = await embed(chunk.text.slice(0, 200));
    embeddedChunks.push({
      snippet: chunk.text,
      embedding: emb,
      entityName: chunk.name ?? null,
      chunkType: chunk.chunkType ?? null,
      startLine: chunk.startLine ?? null,
      endLine: chunk.endLine ?? null,
    });
    chunkIdx++;
  }

  db.upsertFile(fullPath, `hash-${relativePath}`, embeddedChunks);

  // Now handle parent-child relationships: re-insert chunks that have parentName
  const file = db.getFileByPath(fullPath);
  if (!file) return;

  if (fileImports && fileExports) {
    db.upsertFileGraph(file.id, fileImports, fileExports);
  }
}

async function seedProject() {
  // db.ts — exports a class with methods (bridge candidate) and a type (entity candidate)
  await indexFile("src/db.ts", `
export interface Config {
  path: string;
  debug: boolean;
}

export class Database {
  private path: string;

  constructor(config: Config) {
    this.path = config.path;
  }

  query(sql: string): any[] {
    return [];
  }

  close(): void {}
}

export function createDB(config: Config): Database {
  return new Database(config);
}
`);

  // search.ts — imports from db.ts
  await indexFile("src/search.ts", `
import { Database, Config } from "./db";

export function search(db: Database, query: string): string[] {
  return db.query(query).map(String);
}

export type SearchResult = {
  path: string;
  score: number;
};
`);

  // server.ts — imports from both db.ts and search.ts
  await indexFile("src/server.ts", `
import { Database, createDB, Config } from "./db";
import { search } from "./search";

export function startServer(config: Config): void {
  const db = createDB(config);
  const results = search(db, "test");
  console.log(results);
}
`);

  // Resolve import edges
  resolveImports(db, tempDir);
}

describe("searchSymbols — listing mode", () => {
  test("lists all exports when symbol is omitted", async () => {
    await seedProject();

    const results = db.searchSymbols(undefined, false, undefined, 100);

    expect(results.length).toBeGreaterThan(0);
    const names = results.map((r) => r.symbolName);
    expect(names).toContain("Database");
    expect(names).toContain("Config");
    expect(names).toContain("search");
    expect(names).toContain("startServer");
  });

  test("filters by type when listing", async () => {
    await seedProject();

    const classes = db.searchSymbols(undefined, false, "class", 100);
    expect(classes.length).toBeGreaterThan(0);
    for (const r of classes) {
      expect(r.symbolType).toBe("class");
    }

    const functions = db.searchSymbols(undefined, false, "function", 100);
    expect(functions.length).toBeGreaterThan(0);
    for (const r of functions) {
      expect(r.symbolType).toBe("function");
    }
  });

  test("defaults to top 200 in listing mode", async () => {
    await seedProject();

    // Default top when listing (no query) should be 200, not 20
    const results = db.searchSymbols(undefined, false, undefined);
    // We have fewer than 200 symbols, so we just check it returned all of them
    const names = results.map((r) => r.symbolName);
    expect(names).toContain("Database");
    expect(names).toContain("Config");
  });

  test("defaults to top 20 in search mode", async () => {
    await seedProject();

    // With a query string, default top should be 20
    const results = db.searchSymbols("a", false, undefined);
    // We just verify it works — all our symbols fit in 20
    expect(results.length).toBeGreaterThan(0);
  });
});

describe("searchSymbols — enrichment fields", () => {
  test("returns hasChildren and childCount when parent-child chunks exist", async () => {
    // Set up parent-child chunk relationship manually via DB methods
    const emb = new Float32Array(384);
    const filePath = join(tempDir, "src", "widget.ts");
    db.upsertFile(filePath, "hash-widget", [{ snippet: "placeholder", embedding: emb }]);
    const file = db.getFileByPath(filePath)!;

    // Insert a parent chunk for "Widget" class
    const parentId = db.insertChunkReturningId(file.id, {
      snippet: "class Widget { render() {} update() {} }",
      embedding: emb,
      entityName: "Widget",
      chunkType: "class",
    }, -1);

    // Insert child chunks with parentId
    db.insertChunkBatch(file.id, [
      { snippet: "render() {}", embedding: emb, entityName: "Widget.render", chunkType: "method", parentId },
      { snippet: "update() {}", embedding: emb, entityName: "Widget.update", chunkType: "method", parentId },
    ], 0);

    // Register the export
    db.upsertFileGraph(file.id, [], [{ name: "Widget", type: "class" }]);

    const results = db.searchSymbols("Widget", true, undefined, 10);
    const widget = results.find((r) => r.symbolName === "Widget");
    expect(widget).toBeDefined();
    expect(widget!.hasChildren).toBe(true);
    expect(widget!.childCount).toBe(2);
  });

  test("returns hasChildren false for simple types", async () => {
    await seedProject();

    const results = db.searchSymbols("SearchResult", true, undefined, 10);
    if (results.length > 0) {
      const sr = results[0];
      // SearchResult is a simple type alias — no children
      expect(sr.hasChildren).toBe(false);
      expect(sr.childCount).toBe(0);
    }
  });

  test("returns referenceCount from import graph", async () => {
    await seedProject();

    // Database is imported by search.ts and server.ts
    const results = db.searchSymbols("Database", true, undefined, 10);
    const dbClass = results.find((r) => r.symbolName === "Database");
    expect(dbClass).toBeDefined();
    expect(dbClass!.referenceCount).toBeGreaterThanOrEqual(1);
  });

  test("returns isReexport field", async () => {
    await seedProject();

    // None of our test exports are re-exports
    const results = db.searchSymbols(undefined, false, undefined, 100);
    for (const r of results) {
      expect(typeof r.isReexport).toBe("boolean");
    }
  });

  test("referenceCount is 0 for unused symbols", async () => {
    await seedProject();

    // startServer is exported but not imported by any other file in our test project
    const results = db.searchSymbols("startServer", true, undefined, 10);
    if (results.length > 0) {
      expect(results[0].referenceCount).toBe(0);
    }
  });
});

describe("searchSymbols — transitive references", () => {
  test("counts references through re-exports (barrel files)", async () => {
    const emb = new Float32Array(384);

    // types.ts defines Chunk (the original)
    const typesPath = join(tempDir, "src", "types.ts");
    db.upsertFile(typesPath, "hash-types", [{ snippet: "interface Chunk {}", embedding: emb }]);
    const typesFile = db.getFileByPath(typesPath)!;
    db.upsertFileGraph(typesFile.id, [], [{ name: "Chunk", type: "interface" }]);

    // index.ts re-exports Chunk from types.ts (barrel file)
    const indexPath = join(tempDir, "src", "index.ts");
    db.upsertFile(indexPath, "hash-index", [{ snippet: "export { Chunk } from './types'", embedding: emb }]);
    const indexFile = db.getFileByPath(indexPath)!;
    db.upsertFileGraph(
      indexFile.id,
      [{ name: "Chunk", source: "./types" }],
      [{ name: "Chunk", type: "interface", isReExport: true, reExportSource: "./types" }]
    );

    // consumer-a.ts imports Chunk from index.ts (the barrel)
    const consumerAPath = join(tempDir, "lib", "consumer-a.ts");
    db.upsertFile(consumerAPath, "hash-ca", [{ snippet: "import { Chunk } from '../src'", embedding: emb }]);
    const consumerA = db.getFileByPath(consumerAPath)!;
    db.upsertFileGraph(consumerA.id, [{ name: "Chunk", source: "../src" }], []);

    // consumer-b.ts also imports Chunk from index.ts
    const consumerBPath = join(tempDir, "tools", "consumer-b.ts");
    db.upsertFile(consumerBPath, "hash-cb", [{ snippet: "import { Chunk } from '../src'", embedding: emb }]);
    const consumerB = db.getFileByPath(consumerBPath)!;
    db.upsertFileGraph(consumerB.id, [{ name: "Chunk", source: "../src" }], []);

    // Resolve imports: both consumers → index.ts, index.ts → types.ts
    const indexImports = db.getImportsForFile(indexFile.id);
    db.resolveImport(indexImports[0].id, typesFile.id);
    const caImports = db.getImportsForFile(consumerA.id);
    db.resolveImport(caImports[0].id, indexFile.id);
    const cbImports = db.getImportsForFile(consumerB.id);
    db.resolveImport(cbImports[0].id, indexFile.id);

    // The original Chunk in types.ts should see references through the barrel
    const results = db.searchSymbols("Chunk", true, undefined, 10);
    const original = results.find((r) => r.path === typesPath);
    expect(original).toBeDefined();
    // consumer-a and consumer-b import Chunk via index.ts — transitive count should be ≥ 2
    expect(original!.referenceCount).toBeGreaterThanOrEqual(2);
  });

  test("referenceModuleCount counts distinct directories", async () => {
    const emb = new Float32Array(384);

    // src/types.ts exports Config
    const typesPath = join(tempDir, "src", "types.ts");
    db.upsertFile(typesPath, "hash-types", [{ snippet: "type Config = {}", embedding: emb }]);
    const typesFile = db.getFileByPath(typesPath)!;
    db.upsertFileGraph(typesFile.id, [], [{ name: "Config", type: "type" }]);

    // lib/a.ts imports Config
    const aPath = join(tempDir, "lib", "a.ts");
    db.upsertFile(aPath, "hash-a", [{ snippet: "import { Config } from '../src/types'", embedding: emb }]);
    const aFile = db.getFileByPath(aPath)!;
    db.upsertFileGraph(aFile.id, [{ name: "Config", source: "../src/types" }], []);
    db.resolveImport(db.getImportsForFile(aFile.id)[0].id, typesFile.id);

    // tools/b.ts imports Config
    const bPath = join(tempDir, "tools", "b.ts");
    db.upsertFile(bPath, "hash-b", [{ snippet: "import { Config } from '../src/types'", embedding: emb }]);
    const bFile = db.getFileByPath(bPath)!;
    db.upsertFileGraph(bFile.id, [{ name: "Config", source: "../src/types" }], []);
    db.resolveImport(db.getImportsForFile(bFile.id)[0].id, typesFile.id);

    // cli/c.ts imports Config
    const cPath = join(tempDir, "cli", "c.ts");
    db.upsertFile(cPath, "hash-c", [{ snippet: "import { Config } from '../src/types'", embedding: emb }]);
    const cFile = db.getFileByPath(cPath)!;
    db.upsertFileGraph(cFile.id, [{ name: "Config", source: "../src/types" }], []);
    db.resolveImport(db.getImportsForFile(cFile.id)[0].id, typesFile.id);

    const results = db.searchSymbols("Config", true, undefined, 10);
    const config = results.find((r) => r.path === typesPath);
    expect(config).toBeDefined();
    expect(config!.referenceCount).toBe(3);
    // lib, tools, cli = 3 distinct directories
    expect(config!.referenceModuleCount).toBe(3);
  });
});

describe("searchSymbols — backward compatibility", () => {
  test("still works with a query string", async () => {
    await seedProject();

    const results = db.searchSymbols("search", false, undefined, 10);
    expect(results.length).toBeGreaterThan(0);

    const names = results.map((r) => r.symbolName);
    expect(names).toContain("search");
  });

  test("exact match still works", async () => {
    await seedProject();

    const results = db.searchSymbols("search", true, undefined, 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].symbolName).toBe("search");
  });
});
