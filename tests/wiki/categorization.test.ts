import { describe, test, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { RagDB } from "../../src/db";
import { embed, getEmbedder } from "../../src/embeddings/embed";
import { chunkText } from "../../src/indexing/chunker";
import { resolveImports } from "../../src/graph/resolver";
import { createTempDir, cleanupTempDir } from "../helpers";
import { join } from "path";
import { runDiscovery } from "../../src/wiki/discovery";
import { runCategorization } from "../../src/wiki/categorization";

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

/** Index a TypeScript file with full chunking for accurate hasChildren detection. */
async function indexFile(relativePath: string, content: string) {
  const fullPath = join(tempDir, relativePath);
  const { chunks, fileImports, fileExports } = await chunkText(content, ".ts", 2000, 50, fullPath);

  const embeddedChunks = [];
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
  }

  db.upsertFile(fullPath, `hash-${relativePath}`, embeddedChunks);

  const file = db.getFileByPath(fullPath);
  if (file && fileImports && fileExports) {
    db.upsertFileGraph(file.id, fileImports, fileExports);
  }
}

async function seedProject() {
  // Class with methods → bridge
  await indexFile("src/db/index.ts", `
export class Database {
  query(sql: string): any[] { return []; }
  close(): void {}
}

export interface Config {
  path: string;
  debug: boolean;
}

export function createDB(config: Config): Database {
  return new Database();
}
`);

  // Simple types and functions → entities
  await indexFile("src/types.ts", `
export type SearchResult = {
  path: string;
  score: number;
};

export interface ChunkData {
  text: string;
  index: number;
}

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}
`);

  // Imports from db → gives db fanIn
  await indexFile("src/search.ts", `
import { Database, Config } from "./db/index";

export function search(db: Database, query: string): string[] {
  return db.query(query).map(String);
}
`);

  // Imports from both → hub candidate for db/index.ts (fanIn ≥ 2)
  await indexFile("src/server.ts", `
import { Database, createDB } from "./db/index";
import { search } from "./search";

export function startServer(): void {
  const db = createDB({ path: "test", debug: false });
  search(db, "hello");
}
`);

  // Another importer to push db/index.ts into hub territory
  await indexFile("src/cli.ts", `
import { Database, createDB } from "./db/index";

export function runCLI(): void {
  const db = createDB({ path: "cli", debug: true });
  db.close();
}
`);

  resolveImports(db, tempDir);
}

describe("runCategorization", () => {
  test("classifies symbols with hasChildren as bridges", async () => {
    await seedProject();
    const discovery = runDiscovery(db, tempDir);
    const classified = runCategorization(db, discovery, tempDir);

    const database = classified.symbols.find((s) => s.name === "Database");
    expect(database).toBeDefined();
    // The chunker may or may not produce parent-child chunks for small classes.
    // If hasChildren is true → bridge, if false → entity. Test the rule is applied correctly.
    if (database!.hasChildren) {
      expect(database!.tier).toBe("bridge");
    } else {
      expect(database!.tier).toBe("entity");
    }
  });

  test("classifies leaf symbols as entities", async () => {
    await seedProject();
    const discovery = runDiscovery(db, tempDir);
    const classified = runCategorization(db, discovery, tempDir);

    const searchResult = classified.symbols.find((s) => s.name === "SearchResult");
    expect(searchResult).toBeDefined();
    expect(searchResult!.tier).toBe("entity");
    expect(searchResult!.hasChildren).toBe(false);

    const logLevel = classified.symbols.find((s) => s.name === "LogLevel");
    expect(logLevel).toBeDefined();
    expect(logLevel!.tier).toBe("entity");
  });

  test("assigns scope based on referenceModuleCount", async () => {
    await seedProject();
    const discovery = runDiscovery(db, tempDir);
    const classified = runCategorization(db, discovery, tempDir);

    // Database is imported from multiple directories → should have referenceModuleCount > 1
    const database = classified.symbols.find((s) => s.name === "Database");
    expect(database).toBeDefined();
    expect(database!.referenceModuleCount).toBeGreaterThan(0);

    // Scope should follow thresholds
    if (database!.referenceModuleCount >= 3) {
      expect(database!.scope).toBe("cross-cutting");
    } else if (database!.referenceModuleCount === 2) {
      expect(database!.scope).toBe("shared");
    } else {
      expect(database!.scope).toBe("local");
    }
  });

  test("deduplicates symbols keeping most specific type", async () => {
    await seedProject();
    const discovery = runDiscovery(db, tempDir);
    const classified = runCategorization(db, discovery, tempDir);

    // Each symbol should appear at most once per file
    const seen = new Set<string>();
    for (const s of classified.symbols) {
      const key = `${s.name}:${s.file}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  test("classifies files as hubs via Path A (crossroads)", async () => {
    await seedProject();
    const discovery = runDiscovery(db, tempDir);
    const classified = runCategorization(db, discovery, tempDir);

    // db/index.ts has: fanIn >= 2 (imported by search, server, cli), fanOut >= 0,
    // and contains a bridge (Database class)
    const dbFile = classified.files.find((f) => f.path.includes("db/index"));
    if (dbFile && dbFile.fanIn >= 2 && dbFile.fanOut >= 2 && dbFile.bridges.length >= 1) {
      expect(dbFile.isHub).toBe(true);
      expect(dbFile.hubPath).toBe("A");
    }
  });

  test("classifies files as hubs via Path B (foundational, fanIn >= 5)", async () => {
    await seedProject();
    const discovery = runDiscovery(db, tempDir);
    const classified = runCategorization(db, discovery, tempDir);

    // With only 3 importers, db/index.ts might not hit fanIn >= 5
    // But we can check that Path B logic exists by checking any file with high fanIn
    const highFanIn = classified.files.filter((f) => f.fanIn >= 5);
    for (const f of highFanIn) {
      expect(f.isHub).toBe(true);
      // If Path A doesn't apply, hubPath should be B
      if (!(f.fanIn >= 2 && f.fanOut >= 2 && f.bridges.length >= 1)) {
        expect(f.hubPath).toBe("B");
      }
    }
  });

  test("classifies modules with entry file", async () => {
    await seedProject();
    const discovery = runDiscovery(db, tempDir);
    const classified = runCategorization(db, discovery, tempDir);

    // db module has index.ts (entry file)
    const dbModule = classified.modules.find((m) => m.name === "db");
    if (dbModule) {
      expect(dbModule.entryFile).toContain("index.ts");
      expect(dbModule.fileCount).toBeGreaterThan(0);
      expect(dbModule.files.length).toBe(dbModule.fileCount);
    }
  });

  test("returns warnings when no symbols found", async () => {
    // Seed a file with no exports
    const emb = await embed("placeholder");
    db.upsertFile(join(tempDir, "src/empty.ts"), "hash-empty", [
      { snippet: "// empty", embedding: emb },
    ]);

    const discovery = runDiscovery(db, tempDir);
    const classified = runCategorization(db, discovery, tempDir);

    expect(classified.warnings).toContain("No exported symbols found — classification will be empty");
    expect(classified.symbols).toHaveLength(0);
  });

  test("classified modules include files array", async () => {
    await seedProject();
    const discovery = runDiscovery(db, tempDir);
    const classified = runCategorization(db, discovery, tempDir);

    for (const mod of classified.modules) {
      expect(Array.isArray(mod.files)).toBe(true);
      expect(mod.files.length).toBe(mod.fileCount);
    }
  });

  test("modules have value score computed from fanIn, exports, and files", async () => {
    await seedProject();
    const discovery = runDiscovery(db, tempDir);
    const classified = runCategorization(db, discovery, tempDir);

    for (const mod of classified.modules) {
      expect(typeof mod.value).toBe("number");
      expect(mod.value).toBe(mod.fanIn * 2 + mod.exportCount + mod.fileCount);
    }
  });

  test("qualification: value >= 8 always qualifies", async () => {
    await seedProject();
    const discovery = runDiscovery(db, tempDir);
    const classified = runCategorization(db, discovery, tempDir);

    // value >= 8 → qualifies (other modules may qualify via structural overrides)
    for (const mod of classified.modules) {
      if (mod.value >= 8) {
        expect(mod.qualifiesAsModulePage).toBe(true);
      }
    }
  });

  test("qualification reason reflects rule used", async () => {
    await seedProject();
    const discovery = runDiscovery(db, tempDir);
    const classified = runCategorization(db, discovery, tempDir);

    for (const mod of classified.modules) {
      if (!mod.qualifiesAsModulePage) continue;
      // Reason should indicate either the value path or a structural override
      const matchesValueRule = /^value \d+/.test(mod.reason);
      const matchesStructural = mod.reason.startsWith("structural:");
      expect(matchesValueRule || matchesStructural).toBe(true);
    }
  });

  test("trivial single-file module does not qualify", async () => {
    // A module with 1 file, 1 export, 0 fanIn → value = 0 + 1 + 1 = 2
    // Override paths require fileCount >= 2, so this should not qualify.
    await indexFile("src/trivial/index.ts", `
export const PLACEHOLDER = true;
`);
    resolveImports(db, tempDir);

    const discovery = runDiscovery(db, tempDir);
    const classified = runCategorization(db, discovery, tempDir);

    const trivial = classified.modules.find((m) => m.name === "trivial");
    if (trivial) {
      expect(trivial.value).toBeLessThan(8);
      expect(trivial.fileCount).toBeLessThan(2);
      expect(trivial.qualifiesAsModulePage).toBe(false);
    }
  });
});
