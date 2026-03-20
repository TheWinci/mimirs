import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createTempDir, cleanupTempDir, writeFixture } from "../helpers";
import { join } from "path";
import { mkdir } from "fs/promises";

let client: Client;
let tempDir: string;
let transport: StdioClientTransport;

function getText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as Array<{ type: string; text: string }>)[0].text;
}

beforeAll(async () => {
  tempDir = await createTempDir();
  await writeFixture(tempDir, "README.md", "# Test project");

  transport = new StdioClientTransport({
    command: "bun",
    args: ["run", join(import.meta.dir, "..", "..", "src", "main.ts"), "serve"],
    env: { ...process.env, RAG_PROJECT_DIR: tempDir },
  });

  client = new Client({ name: "git-context-test", version: "1.0" });
  await client.connect(transport);
});

afterAll(async () => {
  await client.close();
  await cleanupTempDir(tempDir);
});

describe("git_context tool", () => {
  test("returns graceful message for non-git directory", async () => {
    // tempDir has no .git folder, so it's not a git repository
    const result = await client.callTool({
      name: "git_context",
      arguments: { directory: tempDir },
    });

    const text = getText(result);
    expect(text).toBe("Not a git repository.");
  });

  test("returns git context for a real git repository", async () => {
    // Use the local-rag-mcp repo itself (which is a git repo)
    const repoDir = join(import.meta.dir, "..", "..");
    const result = await client.callTool({
      name: "git_context",
      arguments: { directory: repoDir },
    });

    const text = getText(result);
    // Should not say "Not a git repository" — it should have content
    expect(text).not.toBe("Not a git repository.");
    // Should contain at least one of the expected sections or the clean message
    const hasExpectedContent =
      text.includes("## Uncommitted changes") ||
      text.includes("## Recent commits") ||
      text.includes("## Changed files") ||
      text.includes("Nothing to report");
    expect(hasExpectedContent).toBe(true);
  });

  test("files_only omits commit messages", async () => {
    const repoDir = join(import.meta.dir, "..", "..");
    const result = await client.callTool({
      name: "git_context",
      arguments: { directory: repoDir, files_only: true },
    });

    const text = getText(result);
    if (text !== "Not a git repository." && text !== "Nothing to report (clean working tree, no recent commits in range).") {
      // files_only should NOT include "## Recent commits" section
      expect(text).not.toContain("## Recent commits");
    }
  });

  test("include_diff parameter is accepted without error", async () => {
    const repoDir = join(import.meta.dir, "..", "..");
    const result = await client.callTool({
      name: "git_context",
      arguments: { directory: repoDir, include_diff: true },
    });

    const text = getText(result);
    // Tool should return a valid response (not an MCP error)
    expect(typeof text).toBe("string");
    expect(text.length).toBeGreaterThan(0);
    // If there are tracked uncommitted changes, the diff section appears.
    // If changes are only untracked files, git diff HEAD shows nothing — no ## Diff.
    // Either way the response is valid and contains recognized content.
    const validResponse =
      text.includes("## Diff") ||
      text.includes("## Uncommitted changes") ||
      text.includes("## Recent commits") ||
      text.includes("## Changed files") ||
      text.includes("Nothing to report") ||
      text === "Not a git repository.";
    expect(validResponse).toBe(true);
  });
});
