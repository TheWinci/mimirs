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

  await indexFile("src/search.ts", `
import { Database, Config } from "./db/index";

export function search(db: Database, query: string): string[] {
  return db.query(query).map(String);
}
`);

  await indexFile("src/server.ts", `
import { Database, createDB } from "./db/index";
import { search } from "./search";

export function startServer(): void {
  const db = createDB({ path: "test", debug: false });
  search(db, "hello");
}
`);

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

    const database = classified.symbols.find((s) => s.name === "Database");
    expect(database).toBeDefined();
    expect(database!.referenceModuleCount).toBeGreaterThan(0);

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

    const seen = new Set<string>();
    for (const s of classified.symbols) {
      const key = `${s.name}:${s.file}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  test("every classified file has a numeric pageRank", async () => {
    await seedProject();
    const discovery = runDiscovery(db, tempDir);
    const classified = runCategorization(db, discovery, tempDir);

    expect(classified.files.length).toBeGreaterThan(0);
    for (const f of classified.files) {
      expect(typeof f.pageRank).toBe("number");
      expect(f.pageRank).toBeGreaterThanOrEqual(0);
    }
  });

  test("isTopHub marks the top slice by PageRank", async () => {
    await seedProject();
    const discovery = runDiscovery(db, tempDir);
    const classified = runCategorization(db, discovery, tempDir);

    const hubs = classified.files.filter((f) => f.isTopHub);
    expect(hubs.length).toBeGreaterThan(0);

    // Top hubs must have PageRank >= every non-hub
    const nonHubMax = Math.max(
      0,
      ...classified.files.filter((f) => !f.isTopHub).map((f) => f.pageRank),
    );
    for (const h of hubs) {
      expect(h.pageRank).toBeGreaterThanOrEqual(nonHubMax);
    }
  });

  test("files expose fanIn/fanOut and bridge/entity symbols", async () => {
    await seedProject();
    const discovery = runDiscovery(db, tempDir);
    const classified = runCategorization(db, discovery, tempDir);

    const dbFile = classified.files.find((f) => f.path.includes("db/index"));
    expect(dbFile).toBeDefined();
    expect(dbFile!.fanIn).toBeGreaterThanOrEqual(2);
    expect(Array.isArray(dbFile!.bridges)).toBe(true);
    expect(Array.isArray(dbFile!.entities)).toBe(true);
  });

  test("returns warnings when no symbols found", async () => {
    const emb = await embed("placeholder");
    db.upsertFile(join(tempDir, "src/empty.ts"), "hash-empty", [
      { snippet: "// empty", embedding: emb },
    ]);

    const discovery = runDiscovery(db, tempDir);
    const classified = runCategorization(db, discovery, tempDir);

    expect(classified.warnings).toContain("No exported symbols found — classification will be empty");
    expect(classified.symbols).toHaveLength(0);
  });
});
