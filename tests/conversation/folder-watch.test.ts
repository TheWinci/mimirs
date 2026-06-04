import { describe, test, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { RagDB } from "../../src/db";
import { getEmbedder } from "../../src/embeddings/embed";
import { indexAllSessions, startConversationFolderWatch } from "../../src/conversation/indexer";
import { createTempDir, cleanupTempDir } from "../helpers";
import { mkdirSync, writeFileSync, appendFileSync } from "fs";
import { join } from "path";
import type { JournalEntry } from "../../src/conversation/parser";

let tempDir: string;
let db: RagDB;
let transcriptsDir: string;

beforeAll(async () => {
  await getEmbedder();
});

beforeEach(async () => {
  tempDir = await createTempDir();
  db = new RagDB(tempDir);
  transcriptsDir = join(tempDir, "transcripts");
  mkdirSync(transcriptsDir, { recursive: true });
});

afterEach(async () => {
  db.close();
  await cleanupTempDir(tempDir);
});

function userMsg(text: string, uuid: string, parentUuid: string | null = null): JournalEntry {
  return {
    type: "user",
    uuid,
    parentUuid,
    timestamp: "2026-01-01T00:00:00Z",
    sessionId: "fixture",
    message: { role: "user", content: [{ type: "text", text }] },
  };
}

function assistantMsg(text: string, uuid: string, parentUuid: string): JournalEntry {
  return {
    type: "assistant",
    uuid,
    parentUuid,
    timestamp: "2026-01-01T00:00:01Z",
    sessionId: "fixture",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      usage: { input_tokens: 100, output_tokens: 50 },
    },
  };
}

function serialize(entries: JournalEntry[]): string {
  return entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

function writeSession(sessionId: string, entries: JournalEntry[]): void {
  writeFileSync(join(transcriptsDir, `${sessionId}.jsonl`), serialize(entries));
}

describe("indexAllSessions", () => {
  test("indexes every transcript in the folder", async () => {
    writeSession("sess-a", [
      userMsg("How does the caching layer work?", "a-u1"),
      assistantMsg("Caching uses an LRU map with a five minute TTL in the service layer.", "a-a1", "a-u1"),
    ]);
    writeSession("sess-b", [
      userMsg("How is request routing handled?", "b-u1"),
      assistantMsg("Routing is a switch in the dispatcher keyed on the command name.", "b-a1", "b-u1"),
    ]);

    const total = await indexAllSessions(transcriptsDir, db, tempDir);

    expect(total).toBe(2); // one user→assistant turn per session
    expect(db.getTurnCount("sess-a")).toBe(1);
    expect(db.getTurnCount("sess-b")).toBe(1);
  });

  test("is idempotent — a second pass indexes nothing new", async () => {
    writeSession("sess-a", [
      userMsg("What does the parser do?", "u1"),
      assistantMsg("The parser turns JSONL journal entries into structured turns.", "a1", "u1"),
    ]);

    expect(await indexAllSessions(transcriptsDir, db, tempDir)).toBe(1);
    expect(await indexAllSessions(transcriptsDir, db, tempDir)).toBe(0);
    expect(db.getTurnCount("sess-a")).toBe(1);
  });

  test("picks up appended turns on the next pass without losing the count", async () => {
    writeSession("sess-a", [
      userMsg("First question about indexing", "u1"),
      assistantMsg("First answer describing the indexer pipeline.", "a1", "u1"),
    ]);
    expect(await indexAllSessions(transcriptsDir, db, tempDir)).toBe(1);

    appendFileSync(
      join(transcriptsDir, "sess-a.jsonl"),
      serialize([
        userMsg("Second question about embeddings", "u2", "a1"),
        assistantMsg("Second answer describing the embedding step.", "a2", "u2"),
      ]),
    );

    expect(await indexAllSessions(transcriptsDir, db, tempDir)).toBe(1);
    expect(db.getTurnCount("sess-a")).toBe(2);
  });

  test("returns 0 for a folder that does not exist", async () => {
    expect(await indexAllSessions(join(tempDir, "no-such-dir"), db, tempDir)).toBe(0);
  });
});

describe("startConversationFolderWatch", () => {
  test("backfills all existing transcripts on startup", async () => {
    writeSession("sess-x", [
      userMsg("Question handled by the folder watcher", "u1"),
      assistantMsg("Answer indexed by the folder watcher backfill pass.", "a1", "u1"),
    ]);

    const watcher = startConversationFolderWatch(transcriptsDir, db, tempDir);
    // The initial drain is async (it embeds) — poll until it lands.
    for (let i = 0; i < 100 && db.getTurnCount("sess-x") === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    watcher.close();

    expect(db.getTurnCount("sess-x")).toBe(1);
  });
});

describe("path-collision isolation (cwd filter)", () => {
  const withCwd = (e: JournalEntry, cwd: string): JournalEntry => ({ ...e, cwd });

  test("indexes only this project's transcripts, not a path-collided sibling's", async () => {
    // Claude Code's "/"→"-" folder encoding is lossy, so two real projects can
    // share one transcripts folder. Each session records its true cwd.
    const ownDir = tempDir; // this project
    const siblingDir = `${tempDir}-sibling`; // a DIFFERENT project, same folder

    writeSession("own", [
      withCwd(userMsg("Question from THIS project about caching", "o-u1"), ownDir),
      withCwd(assistantMsg("Answer that belongs to this project.", "o-a1", "o-u1"), ownDir),
    ]);
    writeSession("foreign", [
      withCwd(userMsg("Secret question from ANOTHER project", "f-u1"), siblingDir),
      withCwd(assistantMsg("Answer that must NOT leak into this project.", "f-a1", "f-u1"), siblingDir),
    ]);

    const total = await indexAllSessions(transcriptsDir, db, ownDir);

    expect(total).toBe(1); // only the own session's turn
    expect(db.getTurnCount("own")).toBe(1);
    expect(db.getTurnCount("foreign")).toBe(0); // sibling's turns skipped
    expect(db.getSession("foreign")).toBeNull(); // not even tracked
  });

  test("a session with no recorded cwd is treated as own (legacy transcripts)", async () => {
    writeSession("legacy", [
      userMsg("Old transcript with no cwd field", "l-u1"),
      assistantMsg("Should still index — can't prove it's foreign.", "l-a1", "l-u1"),
    ]);
    expect(await indexAllSessions(transcriptsDir, db, tempDir)).toBe(1);
    expect(db.getTurnCount("legacy")).toBe(1);
  });
});
