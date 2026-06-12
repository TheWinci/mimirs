import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createTempDir, cleanupTempDir, writeFixture } from "../helpers";
import { join } from "path";

// The MCP handler layer for these tools had no test calling it at all — their
// underlying db/graph logic is unit-tested, but the arg parsing, formatting,
// and error messages an agent actually sees were unexercised. One server,
// one indexed fixture project, every previously-uncalled read/write tool.

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
  await writeFixture(
    tempDir,
    "src/app.ts",
    `import { useMath } from "./caller";\nexport function runApp() {\n  return useMath();\n}\n`,
  );
  await writeFixture(
    tempDir,
    "src/math.test.ts",
    `import { addNumbers } from "./math";\nexport function checkMath() {\n  return addNumbers(2, 3) === 5;\n}\n`,
  );

  transport = new StdioClientTransport({
    command: "bun",
    args: ["run", join(import.meta.dir, "..", "..", "src", "main.ts"), "serve"],
    env: { ...process.env, RAG_PROJECT_DIR: tempDir },
  });
  client = new Client({ name: "tool-surface", version: "1.0" });
  await client.connect(transport);

  await client.callTool({ name: "index_files", arguments: { directory: tempDir } });
});

afterAll(async () => {
  await client.close();
  await cleanupTempDir(tempDir);
});

describe("server_info", () => {
  test("reports server, index, embedding, and config sections", async () => {
    const text = getText(await client.callTool({ name: "server_info", arguments: {} }));
    expect(text).toContain("## Server");
    expect(text).toContain("project_dir:");
    expect(text).toContain("## Index");
    expect(text).toContain("model:");
    expect(text).toContain("chunk_size:");
  });
});

describe("search_symbols", () => {
  test("exact match finds a function with its defining file", async () => {
    const text = getText(
      await client.callTool({
        name: "search_symbols",
        arguments: { symbol: "addNumbers", exact: true },
      }),
    );
    expect(text).toContain("addNumbers");
    expect(text).toContain("math.ts");
    expect(text).toContain("function");
  });

  test("no match returns the explicit empty message", async () => {
    const text = getText(
      await client.callTool({
        name: "search_symbols",
        arguments: { symbol: "zzzDoesNotExistAnywhere", exact: true },
      }),
    );
    expect(text).toContain("No exported symbols");
  });
});

describe("project_map", () => {
  test("text map names the fixture files", async () => {
    const text = getText(await client.callTool({ name: "project_map", arguments: {} }));
    expect(text).toContain("math.ts");
    expect(text).toContain("caller.ts");
  });

  test("json format returns parseable structured data", async () => {
    const text = getText(
      await client.callTool({ name: "project_map", arguments: { format: "json" } }),
    );
    const parsed = JSON.parse(text);
    expect(parsed).toBeTruthy();
  });
});

describe("depends_on / dependents", () => {
  test("depends_on lists the imported file", async () => {
    const text = getText(
      await client.callTool({ name: "depends_on", arguments: { file: "src/caller.ts" } }),
    );
    expect(text).toContain("src/caller.ts depends on");
    expect(text).toContain("math.ts");
  });

  test("dependents lists the importers", async () => {
    const text = getText(
      await client.callTool({ name: "dependents", arguments: { file: "src/math.ts" } }),
    );
    expect(text).toContain("src/math.ts is imported by");
    expect(text).toContain("caller.ts");
  });

  test("unknown file gets a not-found message, not an error", async () => {
    const text = getText(
      await client.callTool({ name: "depends_on", arguments: { file: "src/nope.ts" } }),
    );
    expect(text).toContain('File "src/nope.ts" not found in index.');
  });
});

describe("callees", () => {
  test("lists direct callees with definition locations", async () => {
    const text = getText(
      await client.callTool({ name: "callees", arguments: { symbol: "useMath" } }),
    );
    expect(text).toContain('"useMath" directly calls');
    expect(text).toContain("addNumbers");
    expect(text).toContain("math.ts");
  });

  test("a leaf function reports it calls nothing resolvable", async () => {
    const text = getText(
      await client.callTool({ name: "callees", arguments: { symbol: "addNumbers" } }),
    );
    expect(text).toContain("calls nothing resolvable");
  });
});

describe("trace", () => {
  test("finds the path between two connected symbols", async () => {
    const text = getText(
      await client.callTool({ name: "trace", arguments: { from: "runApp", to: "addNumbers" } }),
    );
    expect(text).toContain("runApp");
    expect(text).toContain("useMath");
    expect(text).toContain("addNumbers");
  });

  test("unknown endpoint returns the resolve error", async () => {
    const text = getText(
      await client.callTool({
        name: "trace",
        arguments: { from: "zzzNotASymbol", to: "addNumbers" },
      }),
    );
    expect(text).toContain('No callable named "zzzNotASymbol"');
  });
});

describe("affected", () => {
  test("explicit files map to the test files that import them", async () => {
    const text = getText(
      await client.callTool({ name: "affected", arguments: { files: ["src/math.ts"] } }),
    );
    expect(text).toContain("Changed (indexed)");
    expect(text).toContain("src/math.ts");
    expect(text).toContain("math.test.ts");
  });

  test("no files and no git repo returns guidance, not a crash", async () => {
    const text = getText(await client.callTool({ name: "affected", arguments: {} }));
    expect(text).toContain("not a git repository");
  });
});

describe("annotation lifecycle", () => {
  let annotationId: number;

  test("annotate saves a note against a file and symbol", async () => {
    const text = getText(
      await client.callTool({
        name: "annotate",
        arguments: {
          path: "src/math.ts",
          symbol: "addNumbers",
          note: "Watch out: callers rely on integer overflow wrapping here.",
        },
      }),
    );
    expect(text).toMatch(/Annotation #\d+ saved/);
    expect(text).toContain("src/math.ts");
    expect(text).toContain("addNumbers");
    annotationId = Number(text.match(/#(\d+)/)![1]);
  });

  test("get_annotations by path returns the note", async () => {
    const text = getText(
      await client.callTool({ name: "get_annotations", arguments: { path: "src/math.ts" } }),
    );
    expect(text).toContain("integer overflow");
    expect(text).toContain("addNumbers");
  });

  test("get_annotations by semantic query finds the note", async () => {
    const text = getText(
      await client.callTool({
        name: "get_annotations",
        arguments: { query: "overflow risk in arithmetic helper" },
      }),
    );
    expect(text).toContain("integer overflow");
  });

  test("delete_annotation removes it and a re-read comes back empty", async () => {
    const del = getText(
      await client.callTool({ name: "delete_annotation", arguments: { id: annotationId } }),
    );
    expect(del).toContain(`Annotation #${annotationId} deleted.`);

    const after = getText(
      await client.callTool({ name: "get_annotations", arguments: { path: "src/math.ts" } }),
    );
    expect(after).toContain("No annotations found.");
  });

  test("deleting a missing id reports not found", async () => {
    const text = getText(
      await client.callTool({ name: "delete_annotation", arguments: { id: 999999 } }),
    );
    expect(text).toContain("not found");
  });
});

describe("checkpoint lifecycle", () => {
  test("create_checkpoint stores and confirms", async () => {
    const text = getText(
      await client.callTool({
        name: "create_checkpoint",
        arguments: {
          type: "milestone",
          title: "Implemented math helpers",
          summary: "Added addNumbers plus the useMath and runApp wiring for the fixture project.",
          filesInvolved: ["src/math.ts", "src/caller.ts"],
        },
      }),
    );
    expect(text).toMatch(/Checkpoint #\d+ created: \[milestone\] Implemented math helpers/);
  });

  test("list_checkpoints shows it with type, files, and summary", async () => {
    const text = getText(await client.callTool({ name: "list_checkpoints", arguments: {} }));
    expect(text).toContain("[milestone] Implemented math helpers");
    expect(text).toContain("src/math.ts");
  });

  test("search_checkpoints finds it semantically", async () => {
    const text = getText(
      await client.callTool({
        name: "search_checkpoints",
        arguments: { query: "math helper implementation milestone" },
      }),
    );
    expect(text).toContain("Implemented math helpers");
  });
});

describe("search_analytics", () => {
  test("reports query counts after a search ran", async () => {
    await client.callTool({
      name: "search",
      arguments: { query: "add two numbers helper", directory: tempDir },
    });
    const text = getText(await client.callTool({ name: "search_analytics", arguments: {} }));
    expect(text).toContain("Search analytics");
    expect(text).toMatch(/Total queries:\s+[1-9]/);
  });
});

describe("write_relevant", () => {
  test("suggests an insertion point near the related code", async () => {
    const text = getText(
      await client.callTool({
        name: "write_relevant",
        arguments: {
          content:
            "export function subtractNumbers(alpha: number, beta: number): number {\n  return alpha - beta;\n}",
        },
      }),
    );
    expect(text).toContain("Insert");
    expect(text).toContain("math.ts");
  });
});
