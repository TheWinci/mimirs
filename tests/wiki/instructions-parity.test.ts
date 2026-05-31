import { describe, test, expect } from "bun:test";
import { readFileSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { writePagePrompt } from "../../src/wiki/rebuild";
import { createTempDir, cleanupTempDir } from "../helpers";

// Goldens captured from the pre-refactor prompt builders (scripts/gen-wiki-
// instructions.ts). They guard that lifting the prose into .md + expanding the
// shared blocks reproduces the original output byte-for-byte.
const FIX = join(import.meta.dir, "fixtures");
const INSTR = join(import.meta.dir, "../../src/wiki/instructions");
const SLUG = "example/sample-page";
const NO_OVERRIDE = "/no/such/project"; // existsSync(override) === false → packaged default

function golden(name: string): string {
  return readFileSync(join(FIX, `${name}.txt`), "utf-8");
}

describe("wiki instruction extraction parity", () => {
  test("discovery.md (schemaVersion filled) matches the pre-refactor prompt", () => {
    const md = readFileSync(join(INSTR, "discovery.md"), "utf-8").replaceAll("{{schemaVersion}}", "1");
    expect(md).toBe(golden("golden-discovery"));
  });

  test("write.md matches the pre-refactor coordinator prompt", () => {
    expect(readFileSync(join(INSTR, "write.md"), "utf-8")).toBe(golden("golden-write"));
  });

  test("flow page prompt matches", async () => {
    expect(await writePagePrompt(NO_OVERRIDE, SLUG, "tool")).toBe(golden("golden-page-flow"));
  });

  test("screen page prompt matches", async () => {
    expect(await writePagePrompt(NO_OVERRIDE, SLUG, "screen")).toBe(golden("golden-page-screen"));
  });

  test("overview page prompt (diagram required) matches", async () => {
    expect(await writePagePrompt(NO_OVERRIDE, SLUG, "overview:architecture")).toBe(
      golden("golden-page-overview-arch"),
    );
  });

  test("overview page prompt (diagram exempt) matches", async () => {
    expect(await writePagePrompt(NO_OVERRIDE, SLUG, "overview:configuration")).toBe(
      golden("golden-page-overview-config"),
    );
  });
});

describe("wiki instruction override", () => {
  test("a project writing-contract.md is inlined into every page prompt", async () => {
    const dir = await createTempDir();
    mkdirSync(join(dir, ".mimirs", "wiki"), { recursive: true });
    writeFileSync(join(dir, ".mimirs", "wiki", "writing-contract.md"), "CUSTOM CONTRACT MARKER");
    try {
      const out = await writePagePrompt(dir, SLUG, "tool");
      expect(out).toContain("CUSTOM CONTRACT MARKER");
      expect(out).not.toContain("Source-first writing contract:");
    } finally {
      await cleanupTempDir(dir);
    }
  });

  test("a project page-flow.md replaces the whole flow prompt and still expands tokens", async () => {
    const dir = await createTempDir();
    mkdirSync(join(dir, ".mimirs", "wiki"), { recursive: true });
    writeFileSync(join(dir, ".mimirs", "wiki", "page-flow.md"), "PAGE {{slug}}\n{{writing-contract}}\n{{self-check}}");
    try {
      const out = await writePagePrompt(dir, SLUG, "tool");
      expect(out).toContain(`PAGE ${SLUG}`);
      expect(out).toContain("Source-first writing contract:"); // {{writing-contract}} expanded
      expect(out).toContain("Source-first self-check:"); // {{self-check}} expanded
      expect(out).not.toContain("You are writing one wiki page"); // packaged default not used
    } finally {
      await cleanupTempDir(dir);
    }
  });

  test("overview page fills the kind-specific tokens", async () => {
    // diagram-required kind keeps the diagram bullet; exempt kind swaps it out.
    const arch = await writePagePrompt(NO_OVERRIDE, SLUG, "overview:architecture");
    expect(arch).toContain("the project's components and how they communicate at runtime");
    expect(arch).toContain("- Include at least one diagram");

    const config = await writePagePrompt(NO_OVERRIDE, SLUG, "overview:configuration");
    expect(config).toContain("the project's configuration surface");
    expect(config).toContain("- Diagrams are optional for configuration overviews");
    expect(config).not.toContain("- Include at least one diagram");
  });
});
