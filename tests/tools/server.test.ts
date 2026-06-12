import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createTempDir, cleanupTempDir, writeFixture } from "../helpers";
import { join } from "path";
import { mkdir } from "fs/promises";
import { existsSync } from "fs";

let client: Client;
let tempDir: string;
let transport: StdioClientTransport;

beforeAll(async () => {
  tempDir = await createTempDir();

  await writeFixture(
    tempDir,
    "setup.md",
    `---
name: setup
description: How to set up the project
type: reference
---

Install Bun and run bun install.
`
  );
  await writeFixture(
    tempDir,
    "feedback.md",
    `---
name: testing-prefs
description: User testing preferences
type: feedback
---

Prefer integration tests. Avoid mocks.
`
  );

  transport = new StdioClientTransport({
    command: "bun",
    args: ["run", join(import.meta.dir, "..", "..", "src", "main.ts"), "serve"],
    env: { ...process.env, RAG_PROJECT_DIR: tempDir },
  });

  client = new Client({ name: "test-client", version: "1.0" });
  await client.connect(transport);
});

afterAll(async () => {
  await client.close();
  await cleanupTempDir(tempDir);
});

describe("MCP Server", () => {
  test("lists all tools", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toContain("search");
    expect(names).toContain("index_files");
    expect(names).toContain("index_status");
    expect(names).toContain("remove_file");
    expect(names).toContain("search_analytics");
  });

  test("index_files indexes test directory", async () => {
    const result = await client.callTool({
      name: "index_files",
      arguments: { directory: tempDir },
    });

    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("Indexing complete");
    // Files may already be indexed by auto-index on startup, so check total processed
    expect(text).toMatch(/Indexed: \d|Skipped \(unchanged\): \d/);
  });

  test("search returns ranked results", async () => {
    const result = await client.callTool({
      name: "search",
      arguments: { query: "testing preferences mocking", directory: tempDir },
    });

    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("feedback.md");
  });

  test("search returns message when nothing indexed", async () => {
    const emptyDir = await createTempDir();
    // The dir is a real (empty) mimirs project: it must have an index.db —
    // foreign dirs attach query-only now, so a read tool will not create one
    // (a bare .mimirs/ folder is no longer enough).
    const { RagDB } = await import("../../src/db");
    new RagDB(emptyDir).close();
    const result = await client.callTool({
      name: "search",
      arguments: { query: "anything", directory: emptyDir },
    });

    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("No results found");
    await cleanupTempDir(emptyDir);
  });

  test("read tools refuse to create index.db inside a bare .mimirs folder", async () => {
    const bareDir = await createTempDir();
    await mkdir(join(bareDir, ".mimirs"), { recursive: true });
    const result = await client.callTool({
      name: "search",
      arguments: { query: "anything", directory: bareDir },
    });

    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("No mimirs index at");
    // Query-only attach must not scaffold the foreign DB.
    expect(existsSync(join(bareDir, ".mimirs", "index.db"))).toBe(false);
    await cleanupTempDir(bareDir);
  });

  test("read tools refuse to scaffold a DB in an un-indexed directory", async () => {
    const emptyDir = await createTempDir();
    const result = await client.callTool({
      name: "search",
      arguments: { query: "anything", directory: emptyDir },
    });

    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("No mimirs index at");
    // The side effect this guards against: no .mimirs/ created by a read.
    expect(existsSync(join(emptyDir, ".mimirs"))).toBe(false);
    await cleanupTempDir(emptyDir);
  });

  test("thrown errors come back as readable text with tool name and hint", async () => {
    const result = await client.callTool({
      name: "search",
      arguments: { query: "anything", directory: "/nonexistent/dir/xyz" },
    });

    // The shared wrapper formats failures as "<tool> failed: <message>" plus
    // an actionable hint when one matches — not the SDK's bare error wrap.
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("search failed:");
    expect(text).toContain("Directory does not exist");
    expect(text).toContain("Check the `directory` argument");
  });

  test("index_status returns correct counts", async () => {
    const result = await client.callTool({
      name: "index_status",
      arguments: { directory: tempDir },
    });

    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("Files: 2");
  });

  test("remove_file removes a file from index", async () => {
    const filePath = join(tempDir, "setup.md");
    const result = await client.callTool({
      name: "remove_file",
      arguments: { path: filePath, directory: tempDir },
    });

    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("Removed");

    // Verify count decreased
    const status = await client.callTool({
      name: "index_status",
      arguments: { directory: tempDir },
    });
    const statusText = (status.content as Array<{ type: string; text: string }>)[0].text;
    expect(statusText).toContain("Files: 1");
  });
});
