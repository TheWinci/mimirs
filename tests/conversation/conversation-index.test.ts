import { describe, test, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { RagDB } from "../../src/db";
import { getEmbedder, embed } from "../../src/embeddings/embed";
import { indexConversation } from "../../src/conversation/indexer";
import { createTempDir, cleanupTempDir, writeFixture } from "../helpers";
import { join } from "path";
import type { JournalEntry } from "../../src/conversation/parser";

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

    const result = await indexConversation(path, "test-session", db, tempDir);

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
    const result1 = await indexConversation(path, "test-session", db, tempDir);
    expect(result1.turnsIndexed).toBe(1);

    // Append second batch
    const { writeFileSync } = await import("fs");
    const extraContent = entries2.map((e) => JSON.stringify(e)).join("\n") + "\n";
    writeFileSync(path, extraContent, { flag: "a" });

    // Index from the persisted offset. The cursor is held at the last stored
    // turn's start (it may still have been open), so the resume index is
    // derived internally from MAX(turn_index) — not passed by the caller.
    const result2 = await indexConversation(path, "test-session", db, tempDir, result1.newOffset);
    expect(result2.turnsIndexed).toBe(1); // turn 0 unchanged (skipped), turn 1 new
    expect(db.getTurnCount("test-session")).toBe(2);

    // The re-parsed first turn must not have been duplicated at a new index.
    const rows = db.getTurnRange("test-session", 0, 10);
    expect(rows.map((r) => r.turnIndex)).toEqual([0, 1]);
  });

  test("indexes Bash tool results", async () => {
    const path = await writeJSONL("test.jsonl", [
      userMsg("Run the tests please", "u1"),
      assistantToolUse("Bash", "tool-1", "a1", "u1"),
      userToolResult("tool-1", "PASS src/auth.test.ts\n  3 tests passed\n  0 tests failed", "u2", "a1"),
      assistantMsg("All 3 auth tests passed!", "a2", "u2"),
    ]);

    const result = await indexConversation(path, "test-session", db, tempDir);
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

    await indexConversation(path, "test-session", db, tempDir);

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

    await indexConversation(path, "test-session", db, tempDir);

    const results = db.textSearchConversation("Docker", 5, "test-session");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].snippet).toContain("Docker");
  });

  test("duplicate insertTurn does not create duplicate chunks", async () => {
    const path = await writeJSONL("test.jsonl", [
      userMsg("What is the architecture?", "u1"),
      assistantMsg("The app uses a layered architecture with controllers, services, and repositories.", "a1", "u1"),
    ]);

    // Index the same file twice from offset 0 — the second run should detect duplicates
    const result1 = await indexConversation(path, "dup-session", db, tempDir);
    expect(result1.turnsIndexed).toBe(1);

    const result2 = await indexConversation(path, "dup-session", db, tempDir, 0, 0);
    expect(result2.turnsIndexed).toBe(0); // duplicate — should not re-index

    // Verify only one turn exists
    expect(db.getTurnCount("dup-session")).toBe(1);

    // Verify no duplicate chunks via vector search
    const queryEmb = await embed("architecture");
    const results = db.searchConversation(queryEmb, 10, "dup-session");
    // All results should reference the same turnId
    const turnIds = new Set(results.map((r) => r.turnId));
    expect(turnIds.size).toBeLessThanOrEqual(1);
  });

  // Class invariant for the cursor fix: a turn whose continuation arrives in a
  // LATER read must end up stored whole. The old cursor advanced to the last
  // complete JSONL line (routinely mid-turn) and the continuation was dropped
  // — measured at 46% of turns missing assistant text in a real index.
  test("a turn split across two incremental reads keeps its tail", async () => {
    // Read 1: user question + first assistant message (turn still open —
    // a tool call is in flight).
    const path = await writeJSONL("split.jsonl", [
      userMsg("Please refactor the auth module", "u1"),
      assistantMsg("Starting the refactor now.", "a1", "u1"),
      assistantToolUse("Bash", "tool-1", "a2", "a1"),
    ]);
    const r1 = await indexConversation(path, "test-session", db, tempDir);
    expect(r1.turnsIndexed).toBe(1);

    // Read 2: the tool result + the rest of the assistant's answer arrive.
    const { writeFileSync } = await import("fs");
    const tail = [
      userToolResult("tool-1", "3 files changed", "u2", "a2"),
      assistantMsg("Refactor complete: extracted the token check into middleware.", "a3", "u2"),
    ].map((e) => JSON.stringify(e)).join("\n") + "\n";
    writeFileSync(path, tail, { flag: "a" });

    await indexConversation(path, "test-session", db, tempDir, r1.newOffset);

    // Reconciliation: stored turn must equal a clean one-shot parse.
    expect(db.getTurnCount("test-session")).toBe(1);
    const [stored] = db.getTurnRange("test-session", 0, 0);
    expect(stored.assistantText).toContain("Starting the refactor now.");
    expect(stored.assistantText).toContain("Refactor complete");
    expect(stored.toolsUsed).toContain("Bash");
  });

  // Upgrade safety: sessions indexed before the cursor fix persisted offsets
  // with OLD semantics (end of last complete line). Resuming from such an
  // offset must NOT replace the stored last turn with the next new turn.
  test("legacy end-of-file cursor does not destroy the last stored turn", async () => {
    const path = await writeJSONL("legacy.jsonl", [
      userMsg("first question", "u1"),
      assistantMsg("first answer", "a1", "u1"),
      userMsg("second question", "u2", "a1"),
      assistantMsg("second answer", "a2", "u2"),
    ]);
    await indexConversation(path, "test-session", db, tempDir);

    // Simulate a legacy session row: cursor at END of file (old semantics),
    // as every pre-fix DB has.
    const { statSync } = await import("fs");
    const eof = statSync(path).size;
    db.upsertSession("test-session", path, "2026-01-01T00:00:00Z", statSync(path).mtimeMs, eof);

    // A third turn arrives; the watcher resumes from the legacy EOF cursor.
    const { writeFileSync } = await import("fs");
    const more = [
      userMsg("third question", "u3", "a2"),
      assistantMsg("third answer", "a3", "u3"),
    ].map((e) => JSON.stringify(e)).join("\n") + "\n";
    writeFileSync(path, more, { flag: "a" });

    await indexConversation(path, "test-session", db, tempDir, eof);

    const rows = db.getTurnRange("test-session", 0, 10);
    expect(rows.map((r) => r.userText)).toEqual([
      "first question",
      "second question", // the old bug replaced this with "third question"
      "third question",
    ]);
  });

  // The rewind check must use strong identity, not just userText: repeated
  // identical user messages ("continue") + a legacy EOF cursor made a NEW
  // turn look like a rewind of the stored one and replaced it.
  test("repeated identical user messages survive a legacy EOF cursor", async () => {
    const t = (n: number) => `2026-01-01T00:0${n}:00Z`;
    const mkUser = (uuid: string, parent: string | null, ts: string): JournalEntry => ({
      ...userMsg("continue", uuid, parent), timestamp: ts,
    });
    const mkAsst = (text: string, uuid: string, parent: string, ts: string): JournalEntry => ({
      ...assistantMsg(text, uuid, parent), timestamp: ts,
    });

    const path = await writeJSONL("repeat.jsonl", [
      mkUser("u1", null, t(0)), mkAsst("did part one", "a1", "u1", t(0)),
      mkUser("u2", "a1", t(1)), mkAsst("did part two", "a2", "u2", t(1)),
    ]);
    await indexConversation(path, "test-session", db, tempDir);

    // Legacy cursor: end of file (old semantics).
    const { statSync, writeFileSync } = await import("fs");
    const eof = statSync(path).size;
    db.upsertSession("test-session", path, t(0), statSync(path).mtimeMs, eof);

    // Another identical "continue" turn arrives.
    const more = [
      mkUser("u3", "a2", t(2)), mkAsst("did part three", "a3", "u3", t(2)),
    ].map((e) => JSON.stringify(e)).join("\n") + "\n";
    writeFileSync(path, more, { flag: "a" });

    await indexConversation(path, "test-session", db, tempDir, eof);

    const rows = db.getTurnRange("test-session", 0, 10);
    expect(rows.map((r) => r.assistantText)).toEqual([
      "did part one",
      "did part two", // old bug: replaced by "did part three"
      "did part three",
    ]);
  });

  test("tracks session metadata", async () => {
    const path = await writeJSONL("test.jsonl", [
      userMsg("Hello", "u1"),
      assistantMsg("Hi there!", "a1", "u1"),
    ]);

    await indexConversation(path, "test-session", db, tempDir);

    const session = db.getSession("test-session");
    expect(session).not.toBeNull();
    expect(session!.turnCount).toBe(1);
    // The cursor holds at the LAST turn's start so an open turn is re-parsed
    // whole next pass — for a single-turn file that is byte 0.
    expect(session!.readOffset).toBe(0);

    // Append a second turn: the cursor advances past the (now closed) first
    // turn to the second turn's start.
    const { writeFileSync } = await import("fs");
    const more = [
      userMsg("Another question", "u2", "a1"),
      assistantMsg("Another answer!", "a2", "u2"),
    ].map((e) => JSON.stringify(e)).join("\n") + "\n";
    writeFileSync(path, more, { flag: "a" });

    await indexConversation(path, "test-session", db, tempDir, session!.readOffset);
    const updated = db.getSession("test-session");
    expect(updated!.turnCount).toBe(2);
    expect(updated!.readOffset).toBeGreaterThan(0);
  });
});
