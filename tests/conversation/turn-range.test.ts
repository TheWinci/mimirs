import { describe, test, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { RagDB } from "../../src/db";
import { getEmbedder } from "../../src/embeddings/embed";
import { indexConversation } from "../../src/conversation/indexer";
import { createTempDir, cleanupTempDir, writeFixture } from "../helpers";
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
    cwd: tempDir,
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
    cwd: tempDir,
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      usage: { input_tokens: 100, output_tokens: 50 },
    },
  };
}

// Seed N turns: "Question K" / "Answer K body ..." for K in 0..N-1.
async function seedTurns(n: number): Promise<void> {
  const entries: JournalEntry[] = [];
  let prev = "";
  for (let k = 0; k < n; k++) {
    const u = `u${k}`;
    const a = `a${k}`;
    entries.push(userMsg(`Question ${k}`, u, prev || null));
    entries.push(assistantMsg(`Answer ${k} body content`, a, u));
    prev = a;
  }
  const path = await writeJSONL("session.jsonl", entries);
  await indexConversation(path, "test-session", db, tempDir);
}

describe("getTurnRange", () => {
  test("returns full user and assistant text for an inclusive range", async () => {
    await seedTurns(5);
    const rows = db.getTurnRange("test-session", 1, 3);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.turnIndex)).toEqual([1, 2, 3]);
    // Full text, not a truncated snippet.
    expect(rows[0].userText).toBe("Question 1");
    expect(rows[0].assistantText).toBe("Answer 1 body content");
  });

  test("single-index range returns one turn", async () => {
    await seedTurns(5);
    const rows = db.getTurnRange("test-session", 2, 2);
    expect(rows).toHaveLength(1);
    expect(rows[0].userText).toBe("Question 2");
  });

  test("range past the end returns only existing turns", async () => {
    await seedTurns(3);
    const rows = db.getTurnRange("test-session", 1, 99);
    expect(rows.map((r) => r.turnIndex)).toEqual([1, 2]);
  });

  test("unknown session returns empty", async () => {
    await seedTurns(2);
    expect(db.getTurnRange("no-such-session", 0, 10)).toEqual([]);
  });

  test("rows are ordered oldest-first", async () => {
    await seedTurns(4);
    const rows = db.getTurnRange("test-session", 0, 3);
    const idx = rows.map((r) => r.turnIndex);
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
  });

  test("parses tools_used and files_referenced as arrays", async () => {
    await seedTurns(2);
    const rows = db.getTurnRange("test-session", 0, 1);
    expect(Array.isArray(rows[0].toolsUsed)).toBe(true);
    expect(Array.isArray(rows[0].filesReferenced)).toBe(true);
  });
});
