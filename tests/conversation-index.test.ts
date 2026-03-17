import { describe, test, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { RagDB } from "../src/db";
import { getEmbedder, embed } from "../src/embed";
import { indexConversation } from "../src/conversation-index";
import { createTempDir, cleanupTempDir, writeFixture } from "./helpers";
import { join } from "path";
import type { JournalEntry } from "../src/conversation";

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

// Helper to write a JSONL file
async function writeJSONL(filename: string, entries: JournalEntry[]): Promise<string> {
  const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  return writeFixture(tempDir, filename, content);
}

function userMsg(text: string, uuid: string, parentUuid?: string | null): JournalEntry {
  return {
    type: "user",
    uuid,
    parentUuid: parentUuid ?? null,
    timestamp: "2026-01-01T00:00:00Z",
    sessionId: "test-session",
    message: { role: "user", content: [{ type: "text", text }] },
  };
}

function assistantMsg(text: string, uuid: string, parentUuid: string): JournalEntry {
  return {
    type: "assistant",
    uuid,
    parentUuid,
    timestamp: "2026-01-01T00:00:01Z",
    sessionId: "test-session",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      usage: { input_tokens: 100, output_tokens: 50 },
    },
  };
}

function assistantToolUse(toolName: string, toolId: string, uuid: string, parentUuid: string): JournalEntry {
  return {
    type: "assistant",
    uuid,
    parentUuid,
    timestamp: "2026-01-01T00:00:02Z",
    sessionId: "test-session",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: toolId, name: toolName, input: {} }],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  };
}

function userToolResult(toolUseId: string, content: string, uuid: string, parentUuid: string): JournalEntry {
  return {
    type: "user",
    uuid,
    parentUuid,
    timestamp: "2026-01-01T00:00:03Z",
    sessionId: "test-session",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content }],
    },
  };
}

describe("indexConversation", () => {
  test("indexes turns from a JSONL file", async () => {
    const path = await writeJSONL("test.jsonl", [
      userMsg("How does authentication work in this project?", "u1"),
      assistantMsg("Authentication uses JWT tokens stored in httpOnly cookies. The auth middleware validates tokens on each request.", "a1", "u1"),
      userMsg("Where is the database connection configured?", "u2", "a1"),
      assistantMsg("Database configuration lives in src/config.ts. It reads from environment variables.", "a2", "u2"),
    ]);

    const result = await indexConversation(path, "test-session", db);

    expect(result.turnsIndexed).toBe(2);
    expect(result.totalTokens).toBeGreaterThan(0);
    expect(db.getTurnCount("test-session")).toBe(2);
  });

  test("supports incremental indexing via offset", async () => {
    const entries1 = [
      userMsg("First question about routing", "u1"),
      assistantMsg("Routing is handled by Express router in src/routes.ts", "a1", "u1"),
    ];
    const entries2 = [
      userMsg("Second question about testing", "u2", "a1"),
      assistantMsg("Tests use Jest with supertest for integration testing", "a2", "u2"),
    ];

    // Write first batch
    const path = await writeJSONL("test.jsonl", entries1);
    const result1 = await indexConversation(path, "test-session", db);
    expect(result1.turnsIndexed).toBe(1);

    // Append second batch
    const { writeFileSync } = await import("fs");
    const extraContent = entries2.map((e) => JSON.stringify(e)).join("\n") + "\n";
    writeFileSync(path, extraContent, { flag: "a" });

    // Index from offset
    const result2 = await indexConversation(path, "test-session", db, result1.newOffset, 1);
    expect(result2.turnsIndexed).toBe(1);
    expect(db.getTurnCount("test-session")).toBe(2);
  });

  test("indexes Bash tool results", async () => {
    const path = await writeJSONL("test.jsonl", [
      userMsg("Run the tests please", "u1"),
      assistantToolUse("Bash", "tool-1", "a1", "u1"),
      userToolResult("tool-1", "PASS src/auth.test.ts\n  3 tests passed\n  0 tests failed", "u2", "a1"),
      assistantMsg("All 3 auth tests passed!", "a2", "u2"),
    ]);

    const result = await indexConversation(path, "test-session", db);
    expect(result.turnsIndexed).toBe(1);
  });

  test("conversation search finds relevant turns", async () => {
    const path = await writeJSONL("test.jsonl", [
      userMsg("How does authentication work?", "u1"),
      assistantMsg("Authentication uses JWT tokens. The middleware validates tokens on each request and checks expiration.", "a1", "u1"),
      userMsg("How is the database configured?", "u2", "a1"),
      assistantMsg("Database uses PostgreSQL. Connection pooling is handled by pg-pool with max 20 connections.", "a2", "u2"),
      userMsg("What testing framework do we use?", "u3", "a2"),
      assistantMsg("We use Jest for unit tests and supertest for API integration tests.", "a3", "u3"),
    ]);

    await indexConversation(path, "test-session", db);

    // Search for auth-related content
    const queryEmb = await embed("JWT authentication tokens");
    const results = db.searchConversation(queryEmb, 3, "test-session");

    expect(results.length).toBeGreaterThan(0);
    // The auth turn should be the top result
    expect(results[0].snippet).toMatch(/auth|JWT|token/i);
  });

  test("text search finds keyword matches in conversation", async () => {
    const path = await writeJSONL("test.jsonl", [
      userMsg("Explain the deploy process", "u1"),
      assistantMsg("Deployment uses a CI/CD pipeline with GitHub Actions. The workflow runs tests, builds a Docker image, and pushes to ECR.", "a1", "u1"),
      userMsg("How do database migrations work?", "u2", "a1"),
      assistantMsg("Migrations use knex.js. Run knex migrate:latest to apply pending migrations.", "a2", "u2"),
    ]);

    await indexConversation(path, "test-session", db);

    const results = db.textSearchConversation("Docker", 5, "test-session");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].snippet).toContain("Docker");
  });

  test("tracks session metadata", async () => {
    const path = await writeJSONL("test.jsonl", [
      userMsg("Hello", "u1"),
      assistantMsg("Hi there!", "a1", "u1"),
    ]);

    await indexConversation(path, "test-session", db);

    const session = db.getSession("test-session");
    expect(session).not.toBeNull();
    expect(session!.turnCount).toBe(1);
    expect(session!.readOffset).toBeGreaterThan(0);
  });
});
