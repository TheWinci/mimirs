import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createTempDir, cleanupTempDir, writeFixture } from "../helpers";
import { join } from "path";

let client: Client;
let tempDir: string;
let transport: StdioClientTransport;

beforeAll(async () => {
  tempDir = await createTempDir();

  // Seed a few files so the index isn't empty
  await writeFixture(
    tempDir,
    "src/db.ts",
    `export class Database {
  constructor(private path: string) {}
  query(sql: string) { return []; }
  close() {}
}
`
  );
  await writeFixture(
    tempDir,
    "src/search.ts",
    `import { Database } from "./db";

export function search(query: string, db: Database) {
  return db.query(query);
}
`
  );
  await writeFixture(
    tempDir,
    "README.md",
    "# Test Project\n\nA test project for wiki generation.\n"
  );

  transport = new StdioClientTransport({
    command: "bun",
    args: ["run", join(import.meta.dir, "..", "..", "src", "main.ts"), "serve"],
    env: { ...process.env, RAG_PROJECT_DIR: tempDir },
  });

  client = new Client({ name: "wiki-test-client", version: "1.0" });
  await client.connect(transport);

  // Index the test files first
  await client.callTool({
    name: "index_files",
    arguments: { directory: tempDir },
  });
});

afterAll(async () => {
  await client.close();
  await cleanupTempDir(tempDir);
});

function getText(result: any): string {
  return (result.content as Array<{ type: string; text: string }>)[0].text;
}

describe("generate_wiki", () => {
  test("tool is listed in available tools", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain("generate_wiki");
  });

  test("init mode returns page list and writing rules", async () => {
    const result = await client.callTool({
      name: "generate_wiki",
      arguments: { directory: tempDir },
    });

    const text = getText(result);
    // Should contain the computed page count
    expect(text).toContain("Wiki Generation Plan");
    expect(text).toContain("Computed");
    expect(text).toContain("pages");
    // Should contain writing rules
    expect(text).toContain("Writing Rules");
    expect(text).toContain("Kebab-case");
    expect(text).toContain("Mermaid");
    expect(text).toContain("No guessing");
    // Should contain instructions
    expect(text).toContain("generate_wiki(page: N)");
  });

  test("init mode writes JSON artifacts", async () => {
    const { existsSync } = require("fs");
    // Init was already called in the previous test — artifacts should exist
    expect(existsSync(join(tempDir, "wiki", "_manifest.json"))).toBe(true);
    expect(existsSync(join(tempDir, "wiki", "_content.json"))).toBe(true);
    expect(existsSync(join(tempDir, "wiki", "_classified.json"))).toBe(true);
    expect(existsSync(join(tempDir, "wiki", "_discovery.json"))).toBe(true);
    expect(existsSync(join(tempDir, "wiki", "_update-log.md"))).toBe(true);
  });

  test("page mode returns lightweight summary with sections", async () => {
    const result = await client.callTool({
      name: "generate_wiki",
      arguments: { directory: tempDir, page: 0 },
    });

    const text = getText(result);
    // Should have page metadata
    expect(text).toContain("Page:");
    expect(text).toContain("**Path:**");
    expect(text).toContain("**Kind:**");
    // Should have either candidate sections (module/file) or an exemplar (aggregate)
    const hasCandidates = text.includes("Candidate sections");
    const hasExemplar = text.includes("**Exemplar:**");
    expect(hasCandidates || hasExemplar).toBe(true);
    // Should have available sections manifest
    expect(text).toContain("Available sections");
  });

  test("page mode with section returns section data", async () => {
    // First find a page that has an overview section
    const result = await client.callTool({
      name: "generate_wiki",
      arguments: { directory: tempDir, page: 0 },
    });
    const summary = getText(result);

    // Try fetching a section — overview or exports if available
    if (summary.includes("**overview**")) {
      const sectionResult = await client.callTool({
        name: "generate_wiki",
        arguments: { directory: tempDir, page: 0, section: "overview" },
      });
      const sectionText = getText(sectionResult);
      expect(sectionText).toContain("# Overview");
    }
  });

  test("page mode with invalid section returns error", async () => {
    const result = await client.callTool({
      name: "generate_wiki",
      arguments: { directory: tempDir, page: 0, section: "nonexistent" },
    });

    const text = getText(result);
    expect(text).toContain("Unknown section");
    expect(text).toContain("Valid sections");
  });

  test("warns about empty index for unindexed directory", async () => {
    const emptyDir = await createTempDir();
    const result = await client.callTool({
      name: "generate_wiki",
      arguments: { directory: emptyDir },
    });

    const text = getText(result);
    expect(text).toContain("index is empty");
    expect(text).toContain("index_files");
    await cleanupTempDir(emptyDir);
  });

  test("resume mode reports remaining pages", async () => {
    // Init was already called — all pages should be remaining (none written yet)
    const result = await client.callTool({
      name: "generate_wiki",
      arguments: { directory: tempDir, resume: true },
    });

    const text = getText(result);
    expect(text).toContain("Wiki Resume");
    expect(text).toContain("Remaining");
    expect(text).toContain("Writing Rules");
  });

  test("page mode without init returns error", async () => {
    const emptyDir = await createTempDir();
    const result = await client.callTool({
      name: "generate_wiki",
      arguments: { directory: emptyDir, page: 0 },
    });

    const text = getText(result);
    expect(text).toContain("No manifest found");
    await cleanupTempDir(emptyDir);
  });
});
