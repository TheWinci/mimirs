import { describe, test, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { RagDB } from "../../src/db";
import { getEmbedder, embed } from "../../src/embeddings/embed";
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

describe("checkpoint CRUD", () => {
  test("create and retrieve a checkpoint", async () => {
    const embedding = await embed("Chose sqlite-vec over LanceDB for single-file storage");
    const id = db.createCheckpoint(
      "session-1",
      5,
      "2026-01-15T10:00:00Z",
      "decision",
      "Chose sqlite-vec over LanceDB",
      "We evaluated LanceDB and sqlite-vec. Chose sqlite-vec because it stores everything in a single .db file and works with Bun's built-in SQLite.",
      ["src/db.ts", "package.json"],
      ["database", "architecture"]
    , embedding);

    expect(id).toBeGreaterThan(0);

    const cp = db.getCheckpoint(id);
    expect(cp).not.toBeNull();
    expect(cp!.title).toBe("Chose sqlite-vec over LanceDB");
    expect(cp!.type).toBe("decision");
    expect(cp!.sessionId).toBe("session-1");
    expect(cp!.turnIndex).toBe(5);
    expect(cp!.filesInvolved).toEqual(["src/db.ts", "package.json"]);
    expect(cp!.tags).toEqual(["database", "architecture"]);
  });

  test("list checkpoints returns most recent first", async () => {
    const emb1 = await embed("First checkpoint");
    const emb2 = await embed("Second checkpoint");

    db.createCheckpoint("s1", 0, "2026-01-01T00:00:00Z", "milestone", "Phase 1 done", "Completed first phase.", [], [], emb1);
    db.createCheckpoint("s1", 5, "2026-01-02T00:00:00Z", "decision", "Picked React", "Chose React over Vue.", [], [], emb2);

    const all = db.listCheckpoints();
    expect(all.length).toBe(2);
    // Most recent first
    expect(all[0].title).toBe("Picked React");
    expect(all[1].title).toBe("Phase 1 done");
  });

  test("list checkpoints filters by session", async () => {
    const emb = await embed("checkpoint");
    db.createCheckpoint("s1", 0, "2026-01-01T00:00:00Z", "milestone", "S1 milestone", "Done.", [], [], emb);
    db.createCheckpoint("s2", 0, "2026-01-02T00:00:00Z", "milestone", "S2 milestone", "Done.", [], [], emb);

    const s1Only = db.listCheckpoints("s1");
    expect(s1Only.length).toBe(1);
    expect(s1Only[0].title).toBe("S1 milestone");
  });

  test("list checkpoints filters by type", async () => {
    const emb = await embed("checkpoint");
    db.createCheckpoint("s1", 0, "2026-01-01T00:00:00Z", "decision", "A decision", "Decided something.", [], [], emb);
    db.createCheckpoint("s1", 1, "2026-01-01T01:00:00Z", "blocker", "A blocker", "Blocked by something.", [], [], emb);

    const decisions = db.listCheckpoints(undefined, "decision");
    expect(decisions.length).toBe(1);
    expect(decisions[0].type).toBe("decision");
  });
});

describe("checkpoint semantic search", () => {
  test("finds relevant checkpoints by query", async () => {
    const emb1 = await embed("Chose sqlite-vec for vector storage. Single file database approach.");
    const emb2 = await embed("Phase 14 complete. Project graph generates Mermaid diagrams.");
    const emb3 = await embed("Switched from REST API to MCP server protocol.");

    db.createCheckpoint("s1", 0, "2026-01-01T00:00:00Z", "decision", "sqlite-vec for vectors", "Chose sqlite-vec for single-file storage.", ["src/db.ts"], ["database"], emb1);
    db.createCheckpoint("s1", 10, "2026-01-02T00:00:00Z", "milestone", "Project graph done", "Mermaid diagram generation working.", ["src/graph.ts"], ["graph"], emb2);
    db.createCheckpoint("s1", 20, "2026-01-03T00:00:00Z", "direction_change", "REST to MCP", "Switched protocol from REST to MCP.", ["src/server.ts"], ["protocol"], emb3);

    const queryEmb = await embed("database storage decision");
    const results = db.searchCheckpoints(queryEmb, 3);

    expect(results.length).toBeGreaterThan(0);
    // The sqlite-vec checkpoint should rank highest for "database storage"
    expect(results[0].title).toMatch(/sqlite/i);
  });

  test("search filters by type", async () => {
    const emb1 = await embed("Database decision");
    const emb2 = await embed("Database milestone");

    db.createCheckpoint("s1", 0, "2026-01-01T00:00:00Z", "decision", "DB decision", "Chose a database.", [], [], emb1);
    db.createCheckpoint("s1", 5, "2026-01-02T00:00:00Z", "milestone", "DB milestone", "Database work done.", [], [], emb2);

    const queryEmb = await embed("database");
    const decisions = db.searchCheckpoints(queryEmb, 5, "decision");

    expect(decisions.length).toBe(1);
    expect(decisions[0].type).toBe("decision");
  });

  test("cross-session search works", async () => {
    const emb1 = await embed("Auth uses JWT tokens");
    const emb2 = await embed("Deployed to production");

    db.createCheckpoint("session-a", 0, "2026-01-01T00:00:00Z", "decision", "JWT auth", "Chose JWT for authentication.", [], [], emb1);
    db.createCheckpoint("session-b", 0, "2026-01-05T00:00:00Z", "milestone", "Prod deploy", "First production deployment.", [], [], emb2);

    const queryEmb = await embed("authentication tokens");
    const results = db.searchCheckpoints(queryEmb, 5);

    expect(results.length).toBe(2);
    expect(results[0].title).toMatch(/JWT/i);
  });
});
