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

  // Seed a few files so the index isn't empty for the "indexed" tests
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

  test("returns wiki instructions with index stats", async () => {
    const result = await client.callTool({
      name: "generate_wiki",
      arguments: { directory: tempDir },
    });

    const text = getText(result);
    // Should contain index stats
    expect(text).toMatch(/Index: \d+ files, \d+ chunks/);
    // Should contain the wiki instructions phases
    expect(text).toContain("Phase 0: Mode Detection");
    expect(text).toContain("Phase 1: Discover Structure");
    expect(text).toContain("Phase 6: Index + Finalize");
    expect(text).toContain("Phase 7: Incremental Update");
  });

  test("run=true includes action-required preamble", async () => {
    const result = await client.callTool({
      name: "generate_wiki",
      arguments: { directory: tempDir, run: true },
    });

    const text = getText(result);
    expect(text).toContain("ACTION REQUIRED");
    expect(text).toContain("Follow the phases below step by step");
  });

  test("run=false does not include action-required preamble", async () => {
    const result = await client.callTool({
      name: "generate_wiki",
      arguments: { directory: tempDir, run: false },
    });

    const text = getText(result);
    expect(text).not.toContain("ACTION REQUIRED");
    expect(text).toContain("Ready to generate");
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

  test("instructions include all required wiki rules", async () => {
    const result = await client.callTool({
      name: "generate_wiki",
      arguments: { directory: tempDir },
    });

    const text = getText(result);
    // Key rules from the WIKI_INSTRUCTIONS constant
    expect(text).toContain("Kebab-case");
    expect(text).toContain("See Also");
    expect(text).toContain("Mermaid");
    expect(text).toContain("_manifest.json");
    expect(text).toContain("No bulk reads");
    expect(text).toContain("No guessing signatures");
  });

  test("instructions reference expected wiki file structure", async () => {
    const result = await client.callTool({
      name: "generate_wiki",
      arguments: { directory: tempDir },
    });

    const text = getText(result);
    expect(text).toContain("wiki/");
    expect(text).toContain("architecture.md");
    expect(text).toContain("data-flow.md");
    expect(text).toContain("api-surface.md");
    expect(text).toContain("glossary.md");
    expect(text).toContain("modules/");
    expect(text).toContain("entities/");
    expect(text).toContain("guides/");
  });
});
