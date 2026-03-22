import { describe, test, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { RagDB } from "../../src/db";
import { embed, getEmbedder } from "../../src/embeddings/embed";
import { chunkText } from "../../src/indexing/chunker";
import { resolveImports, generateProjectMap } from "../../src/graph/resolver";
import { createTempDir, cleanupTempDir, writeFixture } from "../helpers";
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

// Helper to index a file with graph metadata
async function indexFileWithGraph(
  path: string,
  content: string,
  extension: string
) {
  const { chunks, fileImports, fileExports } = await chunkText(content, extension, 512, 50, path);
  const emb = await embed(content.slice(0, 200));
  db.upsertFile(path, `hash-${path}`, [{ snippet: content, embedding: emb }]);

  const file = db.getFileByPath(path);
  if (!file) return;

  // Use file-level graph data when available, otherwise aggregate from chunks
  if (fileImports && fileExports) {
    db.upsertFileGraph(file.id, fileImports, fileExports);
  } else {
    const importMap = new Map<string, string>();
    const exportMap = new Map<string, string>();
    for (const chunk of chunks) {
      if (chunk.imports) {
        for (const imp of chunk.imports) {
          if (!importMap.has(imp.source)) importMap.set(imp.source, imp.name);
        }
      }
      if (chunk.exports) {
        for (const exp of chunk.exports) {
          if (!exportMap.has(exp.name)) exportMap.set(exp.name, exp.type);
        }
      }
    }
    db.upsertFileGraph(
      file.id,
      Array.from(importMap, ([source, name]) => ({ name, source })),
      Array.from(exportMap, ([name, type]) => ({ name, type }))
    );
  }
}

describe("chunker import/export extraction", () => {
  test("captures imports from TypeScript code", async () => {
    const code = `import { RagDB } from "./db";\nimport { search } from "./search";\n\nexport function main() { console.log("hello"); }`;
    const { chunks } = await chunkText(code, ".ts", 2000, 50, "test.ts");

    // At least one chunk should have imports
    const allImports = chunks.flatMap((c) => c.imports || []);
    expect(allImports.length).toBeGreaterThan(0);

    const sources = allImports.map((i) => i.source);
    expect(sources).toContain("./db");
    expect(sources).toContain("./search");
  });

  test("captures exports from TypeScript code", async () => {
    const code = `export class MyService {\n  run() { return true; }\n}\n\nexport function helper() { return 1; }`;
    const { chunks } = await chunkText(code, ".ts", 2000, 50, "service.ts");

    const allExports = chunks.flatMap((c) => c.exports || []);
    const names = allExports.map((e) => e.name);
    expect(names).toContain("MyService");
    expect(names).toContain("helper");
  });

  test("non-AST files have no imports/exports", async () => {
    const md = "# Hello\n\nThis is markdown content";
    const { chunks } = await chunkText(md, ".md", 2000, 50);

    for (const chunk of chunks) {
      expect(chunk.imports).toBeUndefined();
      expect(chunk.exports).toBeUndefined();
    }
  });
});

describe("DB graph methods", () => {
  test("upsertFileGraph stores and retrieves imports/exports", () => {
    const emb = new Float32Array(384);
    db.upsertFile(join(tempDir, "a.ts"), "hash-a", [{ snippet: "content", embedding: emb }]);
    const file = db.getFileByPath(join(tempDir, "a.ts"))!;

    db.upsertFileGraph(
      file.id,
      [{ name: "RagDB", source: "./db" }],
      [{ name: "main", type: "function" }]
    );

    const graph = db.getGraph();
    const node = graph.nodes.find((n) => n.id === file.id)!;
    expect(node.exports).toEqual([{ name: "main", type: "function" }]);
  });

  test("upsertFileGraph replaces old data", () => {
    const emb = new Float32Array(384);
    db.upsertFile(join(tempDir, "a.ts"), "hash-a", [{ snippet: "content", embedding: emb }]);
    const file = db.getFileByPath(join(tempDir, "a.ts"))!;

    db.upsertFileGraph(file.id, [{ name: "X", source: "./x" }], []);
    db.upsertFileGraph(file.id, [{ name: "Y", source: "./y" }], []);

    const imports = db.getImportsForFile(file.id);
    expect(imports).toHaveLength(1);
    expect(imports[0].source).toBe("./y");
  });

  test("getSubgraph returns reachable nodes", () => {
    const emb = new Float32Array(384);
    const pathA = join(tempDir, "a.ts");
    const pathB = join(tempDir, "b.ts");
    const pathC = join(tempDir, "c.ts");

    db.upsertFile(pathA, "ha", [{ snippet: "a", embedding: emb }]);
    db.upsertFile(pathB, "hb", [{ snippet: "b", embedding: emb }]);
    db.upsertFile(pathC, "hc", [{ snippet: "c", embedding: emb }]);

    const a = db.getFileByPath(pathA)!;
    const b = db.getFileByPath(pathB)!;
    const c = db.getFileByPath(pathC)!;

    // a → b → c
    db.upsertFileGraph(a.id, [{ name: "B", source: "./b" }], []);
    db.upsertFileGraph(b.id, [{ name: "C", source: "./c" }], []);
    db.upsertFileGraph(c.id, [], [{ name: "doC", type: "function" }]);

    // Resolve imports
    db.resolveImport(db.getImportsForFile(a.id)[0].id, b.id);
    db.resolveImport(db.getImportsForFile(b.id)[0].id, c.id);

    // Subgraph from a, 1 hop: should get a and b
    const sub1 = db.getSubgraph([a.id], 1);
    expect(sub1.nodes.map((n) => n.id).sort()).toEqual([a.id, b.id].sort());

    // Subgraph from a, 2 hops: should get all three
    const sub2 = db.getSubgraph([a.id], 2);
    expect(sub2.nodes.map((n) => n.id).sort()).toEqual([a.id, b.id, c.id].sort());
  });
});

describe("resolveImports", () => {
  test("resolves relative imports with extension probing", () => {
    const emb = new Float32Array(384);
    const pathA = join(tempDir, "src", "server.ts");
    const pathB = join(tempDir, "src", "db.ts");

    db.upsertFile(pathA, "ha", [{ snippet: "a", embedding: emb }]);
    db.upsertFile(pathB, "hb", [{ snippet: "b", embedding: emb }]);

    const a = db.getFileByPath(pathA)!;
    db.upsertFileGraph(a.id, [{ name: "RagDB", source: "./db" }], []);

    const resolved = resolveImports(db, tempDir);
    expect(resolved).toBe(1);

    const imports = db.getImportsForFile(a.id);
    expect(imports[0].resolvedFileId).toBe(db.getFileByPath(pathB)!.id);
  });

  test("skips external/bare specifiers", () => {
    const emb = new Float32Array(384);
    const pathA = join(tempDir, "a.ts");

    db.upsertFile(pathA, "ha", [{ snippet: "a", embedding: emb }]);
    const a = db.getFileByPath(pathA)!;
    db.upsertFileGraph(a.id, [{ name: "z", source: "zod" }, { name: "sql", source: "bun:sqlite" }], []);

    const resolved = resolveImports(db, tempDir);
    expect(resolved).toBe(0);

    const imports = db.getImportsForFile(a.id);
    expect(imports[0].resolvedFileId).toBeNull();
    expect(imports[1].resolvedFileId).toBeNull();
  });
});

describe("generateProjectMap", () => {
  test("generates file-level map", () => {
    const emb = new Float32Array(384);
    const pathA = join(tempDir, "src", "server.ts");
    const pathB = join(tempDir, "src", "db.ts");

    db.upsertFile(pathA, "ha", [{ snippet: "a", embedding: emb }]);
    db.upsertFile(pathB, "hb", [{ snippet: "b", embedding: emb }]);

    const a = db.getFileByPath(pathA)!;
    const b = db.getFileByPath(pathB)!;

    db.upsertFileGraph(a.id, [{ name: "RagDB", source: "./db" }], [{ name: "main", type: "function" }]);
    db.upsertFileGraph(b.id, [], [{ name: "RagDB", type: "class" }]);
    db.resolveImport(db.getImportsForFile(a.id)[0].id, b.id);

    const map = generateProjectMap(db, { projectDir: tempDir, zoom: "file" });

    expect(map).toContain("Project Map");
    expect(map).toContain("server.ts");
    expect(map).toContain("db.ts");
    expect(map).toContain("depends_on:");
    expect(map).toContain("depended_on_by:");
  });

  test("generates directory-level map", () => {
    const emb = new Float32Array(384);
    const pathA = join(tempDir, "src", "server.ts");
    const pathB = join(tempDir, "lib", "db.ts");

    db.upsertFile(pathA, "ha", [{ snippet: "a", embedding: emb }]);
    db.upsertFile(pathB, "hb", [{ snippet: "b", embedding: emb }]);

    const a = db.getFileByPath(pathA)!;
    const b = db.getFileByPath(pathB)!;

    db.upsertFileGraph(a.id, [{ name: "DB", source: "../lib/db" }], []);
    db.upsertFileGraph(b.id, [], []);
    db.resolveImport(db.getImportsForFile(a.id)[0].id, b.id);

    const map = generateProjectMap(db, { projectDir: tempDir, zoom: "directory" });

    expect(map).toContain("directory-level");
    expect(map).toContain("src/");
    expect(map).toContain("lib/");
    expect(map).toContain("Dependencies");
    expect(map).toContain("src -> lib");
  });

  test("focused subgraph filters to nearby files", () => {
    const emb = new Float32Array(384);
    const pathA = join(tempDir, "a.ts");
    const pathB = join(tempDir, "b.ts");
    const pathC = join(tempDir, "c.ts");

    db.upsertFile(pathA, "ha", [{ snippet: "a", embedding: emb }]);
    db.upsertFile(pathB, "hb", [{ snippet: "b", embedding: emb }]);
    db.upsertFile(pathC, "hc", [{ snippet: "c", embedding: emb }]);

    const a = db.getFileByPath(pathA)!;
    const b = db.getFileByPath(pathB)!;

    db.upsertFileGraph(a.id, [{ name: "B", source: "./b" }], []);
    db.upsertFileGraph(b.id, [], []);
    db.upsertFileGraph(db.getFileByPath(pathC)!.id, [], []);
    db.resolveImport(db.getImportsForFile(a.id)[0].id, b.id);

    // Focus on a.ts with 1 hop: should include a and b but not c
    const map = generateProjectMap(db, { projectDir: tempDir, focus: "a.ts", maxHops: 1 });

    expect(map).toContain("a.ts");
    expect(map).toContain("b.ts");
    expect(map).not.toContain("c.ts");
  });

  test("returns placeholder for empty graph", () => {
    const map = generateProjectMap(db, { projectDir: tempDir });
    expect(map).toContain("No files indexed");
  });

  test("handles circular dependencies", () => {
    const emb = new Float32Array(384);
    const pathA = join(tempDir, "a.ts");
    const pathB = join(tempDir, "b.ts");

    db.upsertFile(pathA, "ha", [{ snippet: "a", embedding: emb }]);
    db.upsertFile(pathB, "hb", [{ snippet: "b", embedding: emb }]);

    const a = db.getFileByPath(pathA)!;
    const b = db.getFileByPath(pathB)!;

    db.upsertFileGraph(a.id, [{ name: "B", source: "./b" }], []);
    db.upsertFileGraph(b.id, [{ name: "A", source: "./a" }], []);
    db.resolveImport(db.getImportsForFile(a.id)[0].id, b.id);
    db.resolveImport(db.getImportsForFile(b.id)[0].id, a.id);

    // Should not infinite loop
    const map = generateProjectMap(db, { projectDir: tempDir });
    expect(map).toContain("Project Map");
    expect(map).toContain("depends_on:");
  });

  test("entry points listed separately", () => {
    const emb = new Float32Array(384);
    const pathServer = join(tempDir, "server.ts");
    const pathDb = join(tempDir, "db.ts");

    db.upsertFile(pathServer, "hs", [{ snippet: "s", embedding: emb }]);
    db.upsertFile(pathDb, "hd", [{ snippet: "d", embedding: emb }]);

    const server = db.getFileByPath(pathServer)!;
    const dbFile = db.getFileByPath(pathDb)!;

    db.upsertFileGraph(server.id, [{ name: "DB", source: "./db" }], []);
    db.upsertFileGraph(dbFile.id, [], [{ name: "RagDB", type: "class" }]);
    db.resolveImport(db.getImportsForFile(server.id)[0].id, dbFile.id);

    const map = generateProjectMap(db, { projectDir: tempDir });

    // server.ts has no importers → entry point
    expect(map).toContain("Entry Points");
    expect(map).toContain("server.ts");
  });
});
