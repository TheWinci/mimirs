import { describe, test, expect } from "bun:test";
import {
  parseTurns,
  buildTurnText,
  discoverSessions,
  type JournalEntry,
} from "../src/conversation";

// Helper to create a minimal user text message
function userMsg(text: string, uuid: string, parentUuid?: string | null): JournalEntry {
  return {
    type: "user",
    uuid,
    parentUuid: parentUuid ?? null,
    timestamp: "2026-01-01T00:00:00Z",
    sessionId: "test-session",
    message: {
      role: "user",
      content: [{ type: "text", text }],
    },
  };
}

// Helper to create an assistant text message
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

// Helper to create an assistant tool_use message
function assistantToolUse(
  toolName: string,
  toolId: string,
  uuid: string,
  parentUuid: string
): JournalEntry {
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

// Helper to create a user tool_result message
function userToolResult(
  toolUseId: string,
  content: string,
  uuid: string,
  parentUuid: string,
  toolUseResult?: JournalEntry["toolUseResult"]
): JournalEntry {
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
    toolUseResult,
  };
}

describe("parseTurns", () => {
  test("extracts a simple user-assistant turn", () => {
    const entries: JournalEntry[] = [
      userMsg("Hello, how does auth work?", "u1"),
      assistantMsg("Auth uses JWT tokens stored in httpOnly cookies.", "a1", "u1"),
    ];

    const turns = parseTurns(entries, "test-session");
    expect(turns).toHaveLength(1);
    expect(turns[0].turnIndex).toBe(0);
    expect(turns[0].userText).toBe("Hello, how does auth work?");
    expect(turns[0].assistantText).toBe("Auth uses JWT tokens stored in httpOnly cookies.");
    expect(turns[0].tokenCost).toBe(150);
    expect(turns[0].sessionId).toBe("test-session");
  });

  test("splits multiple turns correctly", () => {
    const entries: JournalEntry[] = [
      userMsg("First question", "u1"),
      assistantMsg("First answer", "a1", "u1"),
      userMsg("Second question", "u2", "a1"),
      assistantMsg("Second answer", "a2", "u2"),
    ];

    const turns = parseTurns(entries);
    expect(turns).toHaveLength(2);
    expect(turns[0].userText).toBe("First question");
    expect(turns[1].userText).toBe("Second question");
  });

  test("captures tool names used in a turn", () => {
    const entries: JournalEntry[] = [
      userMsg("Read the config file", "u1"),
      assistantToolUse("Read", "tool-1", "a1", "u1"),
      userToolResult("tool-1", "file contents here", "u2", "a1"),
      assistantMsg("The config contains...", "a2", "u2"),
    ];

    const turns = parseTurns(entries);
    expect(turns).toHaveLength(1);
    expect(turns[0].toolsUsed).toContain("Read");
  });

  test("indexes Bash tool results", () => {
    const entries: JournalEntry[] = [
      userMsg("Run the tests", "u1"),
      assistantToolUse("Bash", "tool-1", "a1", "u1"),
      userToolResult("tool-1", "3 tests passed, 1 failed\nFAIL: auth.test.ts", "u2", "a1", {
        durationMs: 5000,
      }),
      assistantMsg("One test failed in auth.test.ts", "a2", "u2"),
    ];

    const turns = parseTurns(entries);
    expect(turns).toHaveLength(1);
    expect(turns[0].toolResults).toHaveLength(1);
    expect(turns[0].toolResults[0].toolName).toBe("Bash");
    expect(turns[0].toolResults[0].content).toContain("3 tests passed");
  });

  test("skips Read tool result content", () => {
    const longContent = "x".repeat(1000); // over SHORT_RESULT_THRESHOLD
    const entries: JournalEntry[] = [
      userMsg("Read the file", "u1"),
      assistantToolUse("Read", "tool-1", "a1", "u1"),
      userToolResult("tool-1", longContent, "u2", "a1", {
        filenames: ["/src/db.ts"],
      }),
      assistantMsg("The file contains...", "a2", "u2"),
    ];

    const turns = parseTurns(entries);
    expect(turns).toHaveLength(1);
    // Read content should be skipped (long content from Read tool)
    expect(turns[0].toolResults).toHaveLength(0);
    // But file reference should still be captured
    expect(turns[0].filesReferenced).toContain("/src/db.ts");
  });

  test("indexes short Read results (under threshold)", () => {
    const entries: JournalEntry[] = [
      userMsg("Read the file", "u1"),
      assistantToolUse("Read", "tool-1", "a1", "u1"),
      userToolResult("tool-1", "tiny file", "u2", "a1"),
      assistantMsg("Got it", "a2", "u2"),
    ];

    const turns = parseTurns(entries);
    expect(turns).toHaveLength(1);
    // Short result should be indexed even from Read
    expect(turns[0].toolResults).toHaveLength(1);
  });

  test("indexes Grep tool results", () => {
    const entries: JournalEntry[] = [
      userMsg("Search for auth", "u1"),
      assistantToolUse("Grep", "tool-1", "a1", "u1"),
      userToolResult("tool-1", "src/auth.ts:5: export function authenticate()", "u2", "a1"),
      assistantMsg("Found it in auth.ts", "a2", "u2"),
    ];

    const turns = parseTurns(entries);
    expect(turns[0].toolResults).toHaveLength(1);
    expect(turns[0].toolResults[0].toolName).toBe("Grep");
  });

  test("accumulates token cost across assistant messages", () => {
    const entries: JournalEntry[] = [
      userMsg("Complex question", "u1"),
      assistantToolUse("Read", "tool-1", "a1", "u1"),
      userToolResult("tool-1", "data", "u2", "a1"),
      assistantMsg("Let me analyze...", "a2", "u2"),
    ];

    const turns = parseTurns(entries);
    // tool_use: 10+5=15, text: 100+50=150 → total 165
    expect(turns[0].tokenCost).toBe(165);
  });

  test("captures file references from toolUseResult", () => {
    const entries: JournalEntry[] = [
      userMsg("Check the config", "u1"),
      assistantToolUse("Glob", "tool-1", "a1", "u1"),
      userToolResult("tool-1", "some glob output that is very long " + "x".repeat(600), "u2", "a1", {
        filenames: ["/src/config.ts", "/src/db.ts"],
      }),
      assistantMsg("Found configs", "a2", "u2"),
    ];

    const turns = parseTurns(entries);
    expect(turns[0].filesReferenced).toContain("/src/config.ts");
    expect(turns[0].filesReferenced).toContain("/src/db.ts");
  });

  test("handles startTurnIndex offset", () => {
    const entries: JournalEntry[] = [
      userMsg("Question", "u1"),
      assistantMsg("Answer", "a1", "u1"),
    ];

    const turns = parseTurns(entries, "test", 5);
    expect(turns[0].turnIndex).toBe(5);
  });

  test("skips entries without messages", () => {
    const entries: JournalEntry[] = [
      { type: "queue-operation", timestamp: "2026-01-01T00:00:00Z" },
      { type: "file-history-snapshot", timestamp: "2026-01-01T00:00:00Z" },
      userMsg("Hello", "u1"),
      assistantMsg("Hi!", "a1", "u1"),
    ];

    const turns = parseTurns(entries);
    expect(turns).toHaveLength(1);
    expect(turns[0].userText).toBe("Hello");
  });

  test("creates summary from first 200 chars of assistant text", () => {
    const longText = "A".repeat(300);
    const entries: JournalEntry[] = [
      userMsg("Tell me about it", "u1"),
      assistantMsg(longText, "a1", "u1"),
    ];

    const turns = parseTurns(entries);
    expect(turns[0].summary).toHaveLength(200);
  });

  test("deduplicates tools and files", () => {
    const entries: JournalEntry[] = [
      userMsg("Do stuff", "u1"),
      assistantToolUse("Read", "tool-1", "a1", "u1"),
      userToolResult("tool-1", "data", "u2", "a1", { filenames: ["/a.ts"] }),
      assistantToolUse("Read", "tool-2", "a2", "u2"),
      userToolResult("tool-2", "more data", "u3", "a2", { filenames: ["/a.ts"] }),
      assistantMsg("Done", "a3", "u3"),
    ];

    const turns = parseTurns(entries);
    expect(turns[0].toolsUsed).toEqual(["Read"]); // deduplicated
    expect(turns[0].filesReferenced).toEqual(["/a.ts"]); // deduplicated
  });
});

describe("buildTurnText", () => {
  test("combines user text, assistant text, and tool results", () => {
    const entries: JournalEntry[] = [
      userMsg("Run tests", "u1"),
      assistantToolUse("Bash", "tool-1", "a1", "u1"),
      userToolResult("tool-1", "All 5 tests passed", "u2", "a1"),
      assistantMsg("Tests are green!", "a2", "u2"),
    ];

    const turns = parseTurns(entries);
    const text = buildTurnText(turns[0]);

    expect(text).toContain("User: Run tests");
    expect(text).toContain("Assistant: Tests are green!");
    expect(text).toContain("[Bash]: All 5 tests passed");
  });

  test("handles turn with no tool results", () => {
    const entries: JournalEntry[] = [
      userMsg("What is this?", "u1"),
      assistantMsg("It's a RAG server.", "a1", "u1"),
    ];

    const turns = parseTurns(entries);
    const text = buildTurnText(turns[0]);

    expect(text).toContain("User: What is this?");
    expect(text).toContain("Assistant: It's a RAG server.");
    expect(text).not.toContain("[");
  });
});

describe("discoverSessions", () => {
  test("returns empty array for non-existent project", () => {
    const sessions = discoverSessions("/nonexistent/project/path");
    expect(sessions).toEqual([]);
  });
});
