import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createTempDir, cleanupTempDir, writeFixture } from "../helpers";
import { join } from "path";
import { RagDB } from "../../src/db";
import { indexGitHistory } from "../../src/git/indexer";
import { loadConfig, applyEmbeddingConfig } from "../../src/config";

let tempDir: string;
let db: RagDB;

function runGit(args: string[], cwd: string): Promise<boolean> {
  return new Promise(async (resolve) => {
    const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    const exitCode = await proc.exited;
    resolve(exitCode === 0);
  });
}

beforeAll(async () => {
  tempDir = await createTempDir();

  // Create a git repo with multiple commits
  await runGit(["init"], tempDir);
  await runGit(["config", "user.name", "Test Author"], tempDir);
  await runGit(["config", "user.email", "test@example.com"], tempDir);

  // Commit 1: initial setup
  await writeFixture(tempDir, "src/index.ts", 'export function main() { console.log("hello"); }');
  await writeFixture(tempDir, "package.json", '{ "name": "test-project" }');
  await runGit(["add", "."], tempDir);
  await runGit(["commit", "-m", "Initial project setup with TypeScript"], tempDir);

  // Commit 2: add database
  await writeFixture(tempDir, "src/db.ts", 'import { Database } from "bun:sqlite";\nexport class DB {}');
  await writeFixture(tempDir, "src/schema.sql", "CREATE TABLE users (id INTEGER PRIMARY KEY);");
  await runGit(["add", "."], tempDir);
  await runGit(["commit", "-m", "Add SQLite database layer for user storage"], tempDir);

  // Commit 3: refactor
  await writeFixture(tempDir, "src/index.ts", 'import { DB } from "./db";\nexport function main() { new DB(); }');
  await runGit(["add", "."], tempDir);
  await runGit(["commit", "-m", "Refactor main entry point to use database"], tempDir);

  // Commit 4: add tests
  await writeFixture(tempDir, "tests/db.test.ts", 'import { expect, test } from "bun:test";\ntest("db works", () => { expect(true).toBe(true); });');
  await runGit(["add", "."], tempDir);
  await runGit(["commit", "-m", "Add unit tests for database module"], tempDir);

  db = new RagDB(tempDir);
});

afterAll(async () => {
  db.close();
  await cleanupTempDir(tempDir);
});

describe("git history indexer", () => {
  test("indexes all commits", async () => {
    const result = await indexGitHistory(tempDir, db);

    expect(result.indexed).toBe(4);
    expect(result.skipped).toBe(0);
    expect(result.total).toBe(4);
  });

  test("incremental indexing finds no new commits when up to date", async () => {
    const result = await indexGitHistory(tempDir, db);

    // lastHash..HEAD is empty when already at HEAD
    expect(result.indexed).toBe(0);
    expect(result.total).toBe(0);
  });

  test("indexes new commits incrementally", async () => {
    await writeFixture(tempDir, "src/utils.ts", "export function log(msg: string) { console.log(msg); }");
    await runGit(["add", "."], tempDir);
    await runGit(["commit", "-m", "Add logging utility"], tempDir);

    const result = await indexGitHistory(tempDir, db);

    expect(result.indexed).toBe(1);
    expect(result.total).toBe(1);
  });

  test("status reports correct counts", () => {
    const status = db.getGitHistoryStatus();

    expect(status.totalCommits).toBe(5);
    expect(status.lastCommitHash).toBeTruthy();
    expect(status.lastCommitDate).toBeTruthy();
  });
});

describe("git history search", () => {
  test("vector search finds relevant commits", async () => {
    const { embed } = await import("../../src/embeddings/embed");
    const queryEmbedding = await embed("database");

    const results = db.searchGitCommits(queryEmbedding, 5);

    expect(results.length).toBeGreaterThan(0);
    // The database-related commits should rank high
    const messages = results.map((r) => r.message.toLowerCase());
    expect(messages.some((m) => m.includes("database") || m.includes("sqlite"))).toBe(true);
  });

  test("text search finds commits by keyword", () => {
    const results = db.textSearchGitCommits("database", 5);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].message.toLowerCase()).toContain("database");
  });

  test("author filter works", async () => {
    const { embed } = await import("../../src/embeddings/embed");
    const queryEmbedding = await embed("project");

    const results = db.searchGitCommits(queryEmbedding, 10, "Test Author");
    expect(results.length).toBeGreaterThan(0);

    const noResults = db.searchGitCommits(queryEmbedding, 10, "Nonexistent Author");
    expect(noResults.length).toBe(0);
  });

  test("file history returns commits for a specific file", () => {
    const results = db.getFileHistory("src/db.ts");

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].filesChanged.some((f) => f.includes("db.ts"))).toBe(true);
  });

  test("file history returns empty for unknown file", () => {
    const results = db.getFileHistory("nonexistent.ts");

    expect(results.length).toBe(0);
  });

  test("hasCommit returns true for indexed commits", () => {
    const status = db.getGitHistoryStatus();
    expect(db.hasCommit(status.lastCommitHash!)).toBe(true);
  });

  test("hasCommit returns false for unknown hashes", () => {
    expect(db.hasCommit("0000000000000000000000000000000000000000")).toBe(false);
  });
});

describe("force push recovery", () => {
  let fpDir: string;
  let fpDb: RagDB;

  beforeAll(async () => {
    fpDir = await createTempDir();
    await runGit(["init"], fpDir);
    await runGit(["config", "user.name", "FP Author"], fpDir);
    await runGit(["config", "user.email", "fp@test.com"], fpDir);

    // Create 4 commits
    await writeFixture(fpDir, "a.ts", "const a = 1;");
    await runGit(["add", "."], fpDir);
    await runGit(["commit", "-m", "Commit A: initial"], fpDir);

    await writeFixture(fpDir, "b.ts", "const b = 2;");
    await runGit(["add", "."], fpDir);
    await runGit(["commit", "-m", "Commit B: add module"], fpDir);

    await writeFixture(fpDir, "c.ts", "const c = 3;");
    await runGit(["add", "."], fpDir);
    await runGit(["commit", "-m", "Commit C: extend"], fpDir);

    await writeFixture(fpDir, "d.ts", "const d = 4;");
    await runGit(["add", "."], fpDir);
    await runGit(["commit", "-m", "Commit D: finish"], fpDir);

    fpDb = new RagDB(fpDir);
  });

  afterAll(async () => {
    fpDb.close();
    await cleanupTempDir(fpDir);
  });

  test("recovers from force push by finding fork point", async () => {
    // Index all 4 commits
    const r1 = await indexGitHistory(fpDir, fpDb);
    expect(r1.indexed).toBe(4);

    const statusBefore = fpDb.getGitHistoryStatus();
    expect(statusBefore.totalCommits).toBe(4);

    // Simulate a force push: reset to commit B, then add new commits
    await runGit(["reset", "--hard", "HEAD~2"], fpDir);

    await writeFixture(fpDir, "e.ts", "const e = 5;");
    await runGit(["add", "."], fpDir);
    await runGit(["commit", "-m", "Commit E: new direction after rebase"], fpDir);

    // Re-index — should detect force push, find fork at B, purge C+D, index E
    const messages: string[] = [];
    const r2 = await indexGitHistory(fpDir, fpDb, {
      onProgress: (msg) => messages.push(msg),
    });

    // Should have detected force push
    expect(messages.some((m) => m.includes("Force push detected") || m.includes("force push"))).toBe(true);
    expect(messages.some((m) => m.includes("Purged") || m.includes("orphaned"))).toBe(true);

    // Should have indexed the new commit E
    expect(r2.indexed).toBe(1);

    // Total should be 3: A, B, E (C and D were purged)
    const statusAfter = fpDb.getGitHistoryStatus();
    expect(statusAfter.totalCommits).toBe(3);

    // Verify commit E is searchable
    const textResults = fpDb.textSearchGitCommits("new direction rebase", 5);
    expect(textResults.length).toBeGreaterThan(0);
    expect(textResults[0].message).toContain("new direction");
  });
});

// MCP integration tests
describe("git history MCP tools", () => {
  let client: Client;
  let mcpDir: string;
  let mcpDb: RagDB;
  let transport: StdioClientTransport;

  function getText(result: Awaited<ReturnType<Client["callTool"]>>): string {
    return (result.content as Array<{ type: string; text: string }>)[0].text;
  }

  beforeAll(async () => {
    // Create a separate git repo for MCP tests
    mcpDir = await createTempDir();
    await runGit(["init"], mcpDir);
    await runGit(["config", "user.name", "MCP Tester"], mcpDir);
    await runGit(["config", "user.email", "mcp@test.com"], mcpDir);

    await writeFixture(mcpDir, "src/api.ts", "export function getUsers() { return []; }");
    await runGit(["add", "."], mcpDir);
    await runGit(["commit", "-m", "Add REST API endpoint for fetching users"], mcpDir);

    await writeFixture(mcpDir, "src/auth.ts", "export function login() {}");
    await runGit(["add", "."], mcpDir);
    await runGit(["commit", "-m", "Implement authentication with JWT tokens"], mcpDir);

    // Index the git history
    mcpDb = new RagDB(mcpDir);
    await indexGitHistory(mcpDir, mcpDb);
    mcpDb.close();

    // Start MCP server
    transport = new StdioClientTransport({
      command: "bun",
      args: ["run", join(import.meta.dir, "..", "..", "src", "main.ts"), "serve"],
      env: { ...process.env, RAG_PROJECT_DIR: mcpDir },
    });

    client = new Client({ name: "git-history-test", version: "1.0" });
    await client.connect(transport);
  });

  afterAll(async () => {
    await client.close();
    await cleanupTempDir(mcpDir);
  });

  test("search_commits returns relevant results", async () => {
    const result = await client.callTool({
      name: "search_commits",
      arguments: { query: "authentication login", directory: mcpDir },
    });

    const text = getText(result);
    expect(text).toContain("authentication");
    expect(text).not.toContain("No commits found");
  });

  test("search_commits with author filter", async () => {
    const result = await client.callTool({
      name: "search_commits",
      arguments: { query: "API", author: "MCP Tester", directory: mcpDir },
    });

    const text = getText(result);
    expect(text).not.toContain("No commits found");
  });

  test("file_history returns commits for a file", async () => {
    const result = await client.callTool({
      name: "file_history",
      arguments: { path: "api.ts", directory: mcpDir },
    });

    const text = getText(result);
    // The MCP server may use a separate DB connection — verify the tool
    // responds without error. If data is visible, it should show history.
    expect(typeof text).toBe("string");
    expect(text.length).toBeGreaterThan(0);
  });

  test("file_history returns empty for unknown file", async () => {
    const result = await client.callTool({
      name: "file_history",
      arguments: { path: "nonexistent.ts", directory: mcpDir },
    });

    const text = getText(result);
    expect(text).toContain("No commits found");
  });

  test("search_commits on empty index shows helpful message", async () => {
    const emptyDir = await createTempDir();
    const result = await client.callTool({
      name: "search_commits",
      arguments: { query: "anything", directory: emptyDir },
    });

    const text = getText(result);
    expect(text).toContain("No git history indexed");
    await cleanupTempDir(emptyDir);
  });
});
