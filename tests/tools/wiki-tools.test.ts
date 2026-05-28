import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join } from "path";
import { readFile } from "fs/promises";
import { cleanupTempDir, createTempDir, writeFixture } from "../helpers";

let client: Client;
let tempDir: string;
let transport: StdioClientTransport;

beforeAll(async () => {
  tempDir = await createTempDir();

  await writeFixture(
    tempDir,
    "src/server.ts",
    `import express from "express";

export function checkout(req: any, res: any) {
  return res.json({ ok: true });
}

export function start() {
  const app = express();
  app.post("/checkout", checkout);
}
`,
  );
  await writeFixture(tempDir, "README.md", "# Test Service\n\nA tiny HTTP API used by the wiki tests.\n");

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
  if (!result || !Array.isArray(result.content)) return "";
  return result.content.map((c: any) => c.text ?? "").join("\n");
}

async function readJson(path: string): Promise<any> {
  return JSON.parse(await readFile(join(tempDir, path), "utf-8"));
}

async function callWiki(command: string): Promise<string> {
  const result = await client.callTool({
    name: "wiki",
    arguments: { directory: tempDir, command },
  });
  return getText(result);
}

async function writeDiscovery(value: unknown) {
  await writeFixture(tempDir, "wiki/_discovery.json", JSON.stringify(value, null, 2));
}

describe("wiki rebuild tool", () => {
  test("exposes the new single wiki tool", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    expect(names).toContain("wiki");
    expect(names).not.toContain("generate_wiki");
    expect(names).not.toContain("wiki_lint_page");
    expect(names).not.toContain("wiki_rewrite_page");
  });

  test("shape writes prefetch and returns the discovery prompt", async () => {
    const text = await callWiki("shape");
    expect(text).toContain("Wrote `wiki/_prefetch.json`");
    expect(text).toContain("You are discovering wiki flows");
    expect(text).toContain("wiki/_discovery.json");
    expect(text).toContain("wiki(validate-discovery)");
    expect(text).toContain("one flow and one page per externally triggered behavior");
    expect(text).toContain("Do not create one broad `api`, `endpoints`, or `routes` page");
    expect(text).toContain("Every flow page should have a category `kind`");
    expect(text).toContain("Every flow page must have exactly one `flowIds` item");
    expect(text).toContain("Overview pages (second pass)");
    expect(text).toContain("overview:architecture");
    expect(text).toContain("overview:configuration");
    expect(text).toContain("Omit `inputs` when there is no meaningful input");
    expect(text).toContain("Omit `outputs` when there is no meaningful output");
    expect(text).toContain("Do not list inputs as outputs");
    expect(text).toContain("First identify how this project exposes externally triggered behavior");
    expect(text).toContain("This list is not exhaustive");
    expect(text).toContain("framework-magic layers");
    expect(text).toContain("capture important item state changes");
    expect(text).toContain('"stateChanges"');
    expect(text).not.toContain("prefetch:signals");
    expect(text).not.toContain("Stop: index is empty");

    const prefetch = await readJson("wiki/_prefetch.json");
    expect(prefetch.metadata).toBeDefined();
    expect(prefetch.metadata.lastCommitHash).toBeDefined();
    expect(prefetch.map.files.some((file: any) => file.path === "src/server.ts")).toBe(true);
    expect(prefetch.signals).toBeUndefined();
    expect(prefetch.annotations).toBeDefined();

    const server = prefetch.map.files.find((file: any) => file.path === "src/server.ts");
    expect(server.exports.some((exp: any) => exp.name === "checkout" && typeof exp.line === "number")).toBe(true);
  });

  test("prefetch selectors return nested sections", async () => {
    expect(await callWiki("prefetch:metadata")).toContain('"lastCommitHash"');
    expect(await callWiki("prefetch:map:src/server.ts")).toContain('"fanIn"');
    expect(await callWiki("prefetch:annotations:src/server.ts")).toBe("[]");
  });

  test("validate-discovery reports structural errors", async () => {
    await writeDiscovery({
      metadata: {},
      flows: [{ id: "checkout" }, { id: "checkout" }],
      pages: [
        { slug: "routes/checkout", flowIds: ["checkout"] },
        { slug: "routes/checkout", flowIds: ["missing-flow"] },
      ],
    });

    const text = await callWiki("validate-discovery");
    expect(text).toContain("structural errors");
    expect(text).toContain("Duplicate flow id `checkout`");
    expect(text).toContain("Duplicate page slug `routes/checkout`");
    expect(text).toContain("pages[0] is missing string `kind`");
    expect(text).toContain("references missing flow id `missing-flow`");
    expect(text).not.toContain("inputs is missing");
    expect(text).not.toContain("outputs is missing");
  });

  test("validate-discovery reports malformed state changes", async () => {
    await writeDiscovery({
      metadata: {},
      flows: [
        {
          id: "checkout",
          stateChanges: [
            {
              from: "pending",
              to: "paid",
            },
          ],
        },
        {
          id: "cleanup",
          stateChanges: "not an array",
        },
      ],
      pages: [
        {
          slug: "routes/checkout",
          title: "Checkout route",
          kind: "route",
          flowIds: ["checkout"],
          inputs: ["checkout request"],
          outputs: ["checkout response"],
        },
        {
          slug: "jobs/cleanup",
          title: "Cleanup job",
          kind: "job",
          flowIds: ["cleanup"],
          inputs: ["cleanup schedule"],
          outputs: ["removed files"],
        },
      ],
    });

    const text = await callWiki("validate-discovery");
    expect(text).toContain("flows[0].stateChanges[0] is missing string `item`");
    expect(text).toContain("flows[0].stateChanges[0] is missing string `description`");
    expect(text).toContain("flows[1].stateChanges must be an array when present");
  });

  test("validate-discovery reports malformed page outputs when present", async () => {
    await writeDiscovery({
      metadata: {},
      flows: [{ id: "checkout" }, { id: "cleanup" }],
      pages: [
        {
          slug: "routes/checkout",
          title: "Checkout route",
          kind: "route",
          flowIds: ["checkout"],
          outputs: [],
        },
        {
          slug: "jobs/cleanup",
          title: "Cleanup job",
          kind: "job",
          flowIds: ["cleanup"],
          outputs: ["", 123],
        },
      ],
    });

    const text = await callWiki("validate-discovery");
    expect(text).toContain("pages[0].outputs must contain at least 1 item");
    expect(text).toContain("pages[1].outputs[0] must be a non-empty string");
    expect(text).toContain("pages[1].outputs[1] must be a non-empty string");
  });

  test("validate-discovery reports malformed page inputs when present", async () => {
    await writeDiscovery({
      metadata: {},
      flows: [{ id: "checkout" }, { id: "cleanup" }],
      pages: [
        {
          slug: "routes/checkout",
          title: "Checkout route",
          kind: "route",
          flowIds: ["checkout"],
          inputs: [],
        },
        {
          slug: "jobs/cleanup",
          title: "Cleanup job",
          kind: "job",
          flowIds: ["cleanup"],
          inputs: ["", 123],
        },
      ],
    });

    const text = await callWiki("validate-discovery");
    expect(text).toContain("pages[0].inputs must contain at least 1 item");
    expect(text).toContain("pages[1].inputs[0] must be a non-empty string");
    expect(text).toContain("pages[1].inputs[1] must be a non-empty string");
  });

  test("validate-discovery reports missing files referenced by flows and pages", async () => {
    await writeDiscovery({
      metadata: {},
      flows: [
        {
          id: "checkout",
          files: [
            { path: "src/server.ts", role: "handler" },
            { path: "src/gone.ts", role: "store" },
          ],
          evidence: [
            { path: "src/gone.ts", startLine: 1, endLine: 2 },
            { path: "src/server.ts", startLine: 1, endLine: 2 },
          ],
          stateChanges: [
            {
              item: "order",
              from: null,
              to: "paid",
              description: "creates order",
              files: [{ path: "src/also-gone.ts", role: "writer" }],
              evidence: [{ path: "src/also-gone.ts", startLine: 1, endLine: 2 }],
            },
          ],
        },
      ],
      pages: [
        {
          slug: "routes/checkout",
          title: "Checkout route",
          kind: "route",
          flowIds: ["checkout"],
          primaryFiles: ["src/server.ts", "src/missing.ts"],
          inputs: ["request"],
          outputs: ["response"],
        },
      ],
    });

    const text = await callWiki("validate-discovery");
    expect(text).toContain("references missing file `src/gone.ts`");
    expect(text).toContain("references missing file `src/also-gone.ts`");
    expect(text).toContain("references missing file `src/missing.ts`");
    expect(text).toContain("flows[0].files[1].path");
    expect(text).toContain("pages[0].primaryFiles[1]");
    expect(text).not.toContain("references missing file `src/server.ts`");
  });

  test("validate-discovery allows pages without inputs or outputs", async () => {
    await writeDiscovery({
      metadata: {},
      flows: [{ id: "noop" }],
      pages: [
        {
          slug: "jobs/noop",
          title: "No-op job",
          kind: "job",
          flowIds: ["noop"],
        },
      ],
    });

    const text = await callWiki("validate-discovery");
    expect(text).toContain("passed structural checks");
  });

  test("validate-discovery rejects bundled pages", async () => {
    await writeDiscovery({
      metadata: {},
      flows: [
        { id: "checkout-route", title: "Checkout route", kind: "route" },
        { id: "orders-route", title: "Orders route", kind: "route" },
      ],
      pages: [
        {
          slug: "api",
          title: "API endpoints",
          kind: "overview",
          flowIds: ["checkout-route", "orders-route"],
        },
      ],
    });

    const text = await callWiki("validate-discovery");
    expect(text).not.toContain("kind must be `flow`");
    expect(text).toContain("slug `api` is too broad");
    expect(text).toContain("flowIds must contain exactly one flow id");
  });

  test("validated discovery can be read compactly and by selector", async () => {
    await writeDiscovery({
      metadata: {
        schemaVersion: 1,
        prefetchCommitHash: null,
        createdAt: "2026-05-07T00:00:00.000Z",
      },
      flows: [
        {
          id: "checkout-route",
          title: "Checkout route",
          kind: "route",
          summary: "Handles POST /checkout.",
          confidence: "high",
          entrypoints: [{ path: "/checkout", method: "POST" }],
          files: [{ path: "src/server.ts", role: "handler" }],
          evidence: [{ path: "src/server.ts", startLine: 7, endLine: 9 }],
          stateChanges: [
            {
              item: "checkout response",
              from: null,
              to: "returned",
              trigger: "POST /checkout handler",
              description: "The route creates an OK response for the request.",
              files: [{ path: "src/server.ts", role: "handler" }],
              evidence: [{ path: "src/server.ts", startLine: 3, endLine: 5 }],
            },
          ],
          relatedFlows: [],
        },
      ],
      pages: [
        {
          slug: "routes/checkout",
          title: "Checkout route",
          kind: "route",
          flowIds: ["checkout-route"],
          primaryFiles: ["src/server.ts"],
          mustCover: ["request path", "response"],
          inputs: ["POST /checkout request"],
          outputs: ["JSON response"],
          openQuestions: [],
        },
      ],
    });

    const validation = await callWiki("validate-discovery");
    expect(validation).toContain("passed structural checks");
    expect(validation).toContain("call `wiki(write)` next");

    const compact = await callWiki("discovery");
    expect(compact).toContain('"checkout-route"');
    expect(compact).toContain('"routes/checkout"');
    expect(compact).toContain('"stateChangeCount"');
    expect(compact).toContain('"inputCount"');
    expect(compact).toContain('"outputCount"');
    expect(compact).not.toContain("Handles POST /checkout");

    expect(await callWiki("discovery:flow:checkout-route")).toContain("Handles POST /checkout");
    expect(await callWiki("discovery:flow:checkout-route")).toContain('"stateChanges"');
    expect(await callWiki("discovery:page:routes/checkout")).toContain('"primaryFiles"');
  });

  test("write commands return coordinator and page packets", async () => {
    const coordinator = await callWiki("write");
    expect(coordinator).toContain("split the page-writing work by page slug");
    expect(coordinator).toContain("Call `wiki(discovery)`");
    expect(coordinator).toContain("wiki(write:page:<slug>)");

    const page = await callWiki("write:page:routes/checkout");
    expect(page).toContain("Assigned page slug: `routes/checkout`");
    expect(page).toContain("read the referenced source before writing");
    expect(page).toContain("Read the source files named in `page.primaryFiles`");
    expect(page).toContain("Do not write from the page packet alone");
    expect(page).toContain("Source-first writing contract");
    expect(page).toContain("Treat discovery, page packets, and `mustCover` items as a map");
    expect(page).toContain("Do not paste discovery summaries");
    expect(page).toContain("Source-first self-check");
    expect(page).toContain("Mermaid sequence diagram");
    expect(page).toContain("Explain what this one flow does");
    expect(page).toContain("Use citations sparingly");
    expect(page).toContain("Treat `mustCover` as the list of required topics for this page");
    expect(page).toContain("Every item in `page.mustCover` must be explained");
    expect(page).toContain("Inputs");
    expect(page).toContain("Outputs");
    expect(page).toContain("State changes");
    expect(page).toContain("Key source files");
    expect(page).toContain("## Page packet");
    expect(page).toContain('"Checkout route"');
    expect(page).toContain('"mapEntries"');
    expect(page).not.toContain('"signals"');
    expect(page).toContain("Only link to related pages whose subject is named in `relatedFlows`");
    expect(page).toContain("Example output blocks are illustrative");
    expect(page).toContain("obviously synthetic");
  });

  test("validate-pages reports broken relative markdown links", async () => {
    await writeFixture(
      tempDir,
      "wiki/tools/example.md",
      [
        "# Example",
        "",
        "See [neighbor](./neighbor.md) and [gone](../cli/gone.md).",
        "External [link](https://example.com/x.md) is ignored.",
        "Anchor-only [link](#section) is ignored.",
      ].join("\n"),
    );
    await writeFixture(tempDir, "wiki/tools/neighbor.md", "# Neighbor\n");

    const text = await callWiki("validate-pages");
    expect(text).toContain("broken relative");
    expect(text).toContain("tools/example.md");
    expect(text).toContain("../cli/gone.md");
    expect(text).not.toContain("./neighbor.md");
    expect(text).not.toContain("example.com");
  });

  test("validate-pages reports success when all links resolve", async () => {
    await writeFixture(tempDir, "wiki/tools/only.md", "# Only\n\nNo links here.\n");
    // Remove the broken fixture from the prior test by overwriting it with a valid one.
    await writeFixture(tempDir, "wiki/tools/example.md", "# Example\n\nSee [neighbor](./neighbor.md).\n");

    const text = await callWiki("validate-pages");
    expect(text).toContain("All relative");
    expect(text).toContain("resolve to existing files");
  });

  test("write coordinator prompt mentions the validate-pages gate", async () => {
    const coordinator = await callWiki("write");
    expect(coordinator).toContain("wiki(validate-pages)");
  });

  test("unknown selectors return clear tool errors", async () => {
    const text = await callWiki("prefetch:map:not-real.ts");
    expect(text).toContain("wiki(prefetch:map:not-real.ts) failed");
    expect(text).toContain("No prefetch map entry");
  });
});
