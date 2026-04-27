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

/** Parse the pending-synthesis checklist to extract community ids. */
function parsePendingIds(text: string): string[] {
  const ids: string[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^-\s+`([a-f0-9]+)`/);
    if (m) ids.push(m[1]);
  }
  return ids;
}

/** Walk init → synthesis → write_synthesis → init until the manifest exists. */
async function runFullWikiFlow(dir: string): Promise<string> {
  const first = await client.callTool({
    name: "generate_wiki",
    arguments: { directory: dir },
  });
  const firstText = getText(first);
  const ids = parsePendingIds(firstText);

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    await client.callTool({
      name: "write_synthesis",
      arguments: {
        directory: dir,
        communityId: id,
        payload: {
          communityId: id,
          name: `Community ${i}`,
          slug: `community-${i}`,
          purpose: `Auto-generated synthesis for test community ${i}.`,
          kind: "community",
          sections: [
            { title: "Overview", purpose: "Describe what this community does." },
          ],
        },
      },
    });
  }

  const second = await client.callTool({
    name: "generate_wiki",
    arguments: { directory: dir },
  });
  return getText(second);
}

describe("generate_wiki", () => {
  test("tool is listed in available tools", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain("generate_wiki");
    expect(names).toContain("write_synthesis");
  });

  test("first call returns pending synthesis checklist", async () => {
    const result = await client.callTool({
      name: "generate_wiki",
      arguments: { directory: tempDir },
    });

    const text = getText(result);
    expect(text).toContain("Step 1 complete");
    expect(text).toContain("Pending synthesis");
    expect(text).toContain("generate_wiki(synthesis:");
    expect(text).toContain("write_synthesis");
  });

  test("synthesis mode returns per-community prompt", async () => {
    const initResult = await client.callTool({
      name: "generate_wiki",
      arguments: { directory: tempDir },
    });
    const ids = parsePendingIds(getText(initResult));
    expect(ids.length).toBeGreaterThan(0);

    const synthResult = await client.callTool({
      name: "generate_wiki",
      arguments: { directory: tempDir, synthesis: ids[0] },
    });
    const synthText = getText(synthResult);
    expect(synthText.length).toBeGreaterThan(50);
    expect(synthText).toContain(ids[0]);
  });

  test("write_synthesis rejects invalid slug", async () => {
    const initResult = await client.callTool({
      name: "generate_wiki",
      arguments: { directory: tempDir },
    });
    const ids = parsePendingIds(getText(initResult));
    if (ids.length === 0) return;

    const result = await client.callTool({
      name: "write_synthesis",
      arguments: {
        directory: tempDir,
        communityId: ids[0],
        payload: {
          communityId: ids[0],
          name: "Bad",
          slug: "Not Kebab Case",
          purpose: "x",
          sections: [{ title: "Overview", purpose: "y" }],
        },
      },
    });
    const text = getText(result);
    expect(text).toContain("rejected");
  });

  test("after all syntheses stored, init returns manifest plan", async () => {
    const text = await runFullWikiFlow(tempDir);
    expect(text).toContain("Wiki Generation Plan");
    expect(text).toContain("Computed");
    expect(text).toContain("pages");
    expect(text).toContain("Writing rules");
    expect(text).toContain("wiki/_meta/writing-rules.md");
    expect(text).toContain("generate_wiki(page: N)");
  });

  test("manifest + content artifacts written to disk", async () => {
    const { existsSync } = require("fs");
    expect(existsSync(join(tempDir, "wiki", "_meta", "_manifest.json"))).toBe(true);
    expect(existsSync(join(tempDir, "wiki", "_meta", "_content.json"))).toBe(true);
    expect(existsSync(join(tempDir, "wiki", "_meta", "_classified.json"))).toBe(true);
    expect(existsSync(join(tempDir, "wiki", "_meta", "_discovery.json"))).toBe(true);
    expect(existsSync(join(tempDir, "wiki", "_meta", "_syntheses.json"))).toBe(true);
    expect(existsSync(join(tempDir, "wiki", "_meta", "_bundles.json"))).toBe(true);
    expect(existsSync(join(tempDir, "wiki", "_update-log.md"))).toBe(true);
  });

  test("page mode returns payload with sections", async () => {
    const result = await client.callTool({
      name: "generate_wiki",
      arguments: { directory: tempDir, page: 0 },
    });

    const text = getText(result);
    expect(text).toContain("Page payload");
    expect(text).toContain("**Path:**");
    expect(text).toContain("**Kind:**");
    expect(text).toContain("Sections to write");
  });

  test("page mode with out-of-range index returns error", async () => {
    const result = await client.callTool({
      name: "generate_wiki",
      arguments: { directory: tempDir, page: 999 },
    });
    const text = getText(result);
    expect(text.toLowerCase()).toMatch(/out of range|invalid|not found/);
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
    const result = await client.callTool({
      name: "generate_wiki",
      arguments: { directory: tempDir, resume: true },
    });

    const text = getText(result);
    expect(text).toContain("Wiki Resume");
    expect(text).toContain("Remaining");
    expect(text).toContain("Writing rules");
    expect(text).toContain("wiki/_meta/writing-rules.md");
  });

  test("page mode without manifest returns error", async () => {
    const emptyDir = await createTempDir();
    const result = await client.callTool({
      name: "generate_wiki",
      arguments: { directory: emptyDir, page: 0 },
    });

    const text = getText(result);
    expect(text).toContain("No manifest");
    await cleanupTempDir(emptyDir);
  });

  test("wiki_lint_page flags missing file reference", async () => {
    const { writeFileSync, mkdirSync } = require("fs");
    const badPage = join(tempDir, "wiki", "communities", "bad.md");
    mkdirSync(join(tempDir, "wiki", "communities"), { recursive: true });
    writeFileSync(badPage, "# Bad\n\nSee `src/ghost.ts` for details.\n");

    const result = await client.callTool({
      name: "wiki_lint_page",
      arguments: { directory: tempDir, path: "wiki/communities/bad.md" },
    });
    const text = getText(result);
    expect(text).toContain("missing-file");
    expect(text).toContain("src/ghost.ts");
  });

  test("wiki_lint_page on clean page reports clean", async () => {
    const { writeFileSync } = require("fs");
    const goodPage = join(tempDir, "wiki", "communities", "good.md");
    writeFileSync(goodPage, "# Good\n\nReferences `src/db.ts` which exists.\n");

    const result = await client.callTool({
      name: "wiki_lint_page",
      arguments: { directory: tempDir, path: "wiki/communities/good.md" },
    });
    const text = getText(result);
    expect(text.toLowerCase()).toContain("lint clean");
  });

  test("wiki_rewrite_page returns same shape as generate_wiki(page)", async () => {
    const viaGenerate = await client.callTool({
      name: "generate_wiki",
      arguments: { directory: tempDir, page: 0 },
    });
    const viaRewrite = await client.callTool({
      name: "wiki_rewrite_page",
      arguments: { directory: tempDir, page: 0 },
    });
    const genText = getText(viaGenerate);
    const rewriteText = getText(viaRewrite);
    expect(rewriteText).toContain("Page payload");
    expect(rewriteText).toContain("**Path:**");
    // Same path + kind — content may differ by timestamp-like fields but structure matches.
    const pathLine = (s: string) => (s.match(/\*\*Path:\*\*.*$/m) ?? [""])[0];
    expect(pathLine(rewriteText)).toBe(pathLine(genText));
  });
});
