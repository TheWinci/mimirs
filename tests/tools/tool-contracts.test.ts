import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createTempDir, cleanupTempDir, writeFixture } from "../helpers";
import { readFileSync } from "fs";
import { join } from "path";

// Part 2 #7: the tool/CLI adapter layer is the product surface agents call, and
// it was the thinnest-tested. These exercise the handlers themselves: the
// read_relevant line-range contract, search filter path-resolution, and the
// impact/usages guidance + ambiguity branches an agent actually hits.

let client: Client;
let tempDir: string;
let transport: StdioClientTransport;

function getText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as Array<{ type: string; text: string }>)[0].text;
}

beforeAll(async () => {
  tempDir = await createTempDir();

  await writeFixture(
    tempDir,
    "src/math.ts",
    `export function addNumbers(alpha: number, beta: number): number {\n  return alpha + beta;\n}\n`,
  );
  await writeFixture(
    tempDir,
    "src/caller.ts",
    `import { addNumbers } from "./math";\nexport function useMath() {\n  return addNumbers(1, 2);\n}\n`,
  );
  await writeFixture(tempDir, "src/widget.ts", `export class WidgetThing {\n  doStuff() { return 1; }\n}\n`);
  await writeFixture(tempDir, "src/dupA.ts", `export function dupTarget() { return "a"; }\n`);
  await writeFixture(tempDir, "src/dupB.ts", `export function dupTarget() { return "b"; }\n`);
  await writeFixture(tempDir, "docs/guide.md", `# Guide\n\nThe addNumbers helper adds two numbers.\n`);

  transport = new StdioClientTransport({
    command: "bun",
    args: ["run", join(import.meta.dir, "..", "..", "src", "main.ts"), "serve"],
    env: { ...process.env, RAG_PROJECT_DIR: tempDir },
  });
  client = new Client({ name: "tool-contracts", version: "1.0" });
  await client.connect(transport);

  // Ensure the index (and symbol graph) is fully built before asserting.
  await client.callTool({ name: "index_files", arguments: { directory: tempDir } });
});

afterAll(async () => {
  await client.close();
  await cleanupTempDir(tempDir);
});

describe("read_relevant line-range contract", () => {
  test("the rendered path:start-end maps to the real file lines", async () => {
    const result = await client.callTool({
      name: "read_relevant",
      arguments: { query: "addNumbers alpha beta", directory: tempDir },
    });
    const text = getText(result);

    // Header format: [score] /abs/path:START-END  •  entity
    const m = text.match(/(\/[^\s:]+):(\d+)-(\d+)/);
    expect(m).not.toBeNull();
    const [, path, startStr, endStr] = m!;
    const start = Number(startStr);
    const end = Number(endStr);
    expect(start).toBeGreaterThanOrEqual(1);
    expect(end).toBeGreaterThanOrEqual(start);

    // The reported lines, read straight from the file, contain the chunk's symbol.
    const fileLines = readFileSync(path, "utf8").split("\n");
    const slice = fileLines.slice(start - 1, end).join("\n");
    expect(slice).toContain("addNumbers");
  });
});

describe("search filter path-resolution at the tool layer", () => {
  test("dirs scopes to a relative subdir; excludeDirs removes one", async () => {
    const inSrc = getText(
      await client.callTool({ name: "search", arguments: { query: "addNumbers", directory: tempDir, dirs: ["src"] } }),
    );
    expect(inSrc).toContain("math.ts");
    expect(inSrc).not.toContain("guide.md");

    const noDocs = getText(
      await client.callTool({ name: "search", arguments: { query: "addNumbers", directory: tempDir, excludeDirs: ["docs"] } }),
    );
    expect(noDocs).not.toContain("guide.md");
  });

  test("extensions scopes to a file type", async () => {
    const mdOnly = getText(
      await client.callTool({ name: "search", arguments: { query: "addNumbers", directory: tempDir, extensions: ["md"] } }),
    );
    expect(mdOnly).toContain("guide.md");
    expect(mdOnly).not.toContain("math.ts");
  });
});

describe("impact / usages guidance branches", () => {
  test("impact on a class name returns the functions-and-methods guidance", async () => {
    const text = getText(
      await client.callTool({ name: "impact", arguments: { symbol: "WidgetThing", directory: tempDir } }),
    );
    expect(text).toContain("tracks functions and methods");
  });

  test("impact on an ambiguous symbol lists the candidate files", async () => {
    const text = getText(
      await client.callTool({ name: "impact", arguments: { symbol: "dupTarget", directory: tempDir } }),
    );
    expect(text).toMatch(/defined in 2 places/);
    expect(text).toContain("dupA.ts");
    expect(text).toContain("dupB.ts");
  });

  test("impact disambiguates when given a file", async () => {
    const text = getText(
      await client.callTool({ name: "impact", arguments: { symbol: "dupTarget", file: "src/dupA.ts", directory: tempDir } }),
    );
    expect(text).not.toMatch(/defined in 2 places/);
  });

  test("usages of an unreferenced symbol returns the actionable hint", async () => {
    const text = getText(
      await client.callTool({ name: "usages", arguments: { symbol: "nonexistentSymbolXyz", directory: tempDir } }),
    );
    expect(text).toContain("No usages");
    expect(text).toContain("definition file");
  });
});
