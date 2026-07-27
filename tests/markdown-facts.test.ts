import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { chunk, type ImportFact, walk } from "@winci/bun-chunk";

const FIXTURES = join(import.meta.dir, "fixtures", "markdown");

async function result(fixture: string) {
  const path = join(FIXTURES, fixture);
  return chunk(path, await Bun.file(path).text());
}

function imports(
  values: Awaited<ReturnType<typeof result>>["facts"],
): ImportFact[] {
  return values.filter((fact): fact is ImportFact => fact.kind === "import");
}

describe("Markdown chunks and source facts", () => {
  test("preserves inline links, images, autolinks, and reference definitions", async () => {
    expect(
      imports((await result("links.md")).facts).map((fact) => [
        fact.source,
        fact.imported,
        fact.owner?.name,
      ]),
    ).toEqual([
      ["docs/guide.md", "link", "Resources"],
      ["docs/api reference.md", "link", "Resources"],
      ["https://example.com/docs", "link", "Resources"],
      ["images/diagram.svg", "image", "Resources"],
      ["docs/architecture.md", "reference", "Resources"],
      ["images/logo.png", "reference", "Resources"],
      ["docs/architecture.md", "link", "Resources"],
      ["images/logo.png", "image", "Resources"],
    ]);
  });

  test("ignores links inside inline and fenced code", async () => {
    expect(
      imports((await result("code-links.md")).facts).map((fact) => fact.source),
    ).toEqual(["real.md"]);
  });

  test("rejects fragments, unsafe schemes, data URIs, and templates", async () => {
    const sources = imports((await result("links.md")).facts).map(
      (fact) => fact.source,
    );
    expect(sources).not.toContain("#resources");
    expect(sources.some((source) => /^(?:data|mailto):/i.test(source))).toBe(
      false,
    );
    expect(sources.some((source) => source.includes("{{"))).toBe(false);
  });

  test("keeps meaningful section bodies out of whitespace gaps", async () => {
    const value = await result("structure.md");
    for (const current of walk(value.chunks)) {
      if (current.kind === "gap") expect(current.text?.trim()).toBe("");
    }
  });

  test("routes both Markdown extensions through the dedicated strategy", async () => {
    expect(await result("structure.md")).toMatchObject({
      language: "markdown",
      strategy: "markdown",
    });
    expect(await result("headings.markdown")).toMatchObject({
      language: "markdown",
      strategy: "markdown",
    });
  });

  test("does not fabricate Markdown calls or exports", async () => {
    const values = (await result("links.md")).facts;
    expect(values.some((fact) => fact.kind === "call")).toBe(false);
    expect(values.some((fact) => fact.kind === "export")).toBe(false);
  });

  test("MD-E1 resolves reference uses and normalizes explicit destinations", async () => {
    expect(imports((await result("references.md")).facts).map((fact) => [
      fact.source,
      fact.imported,
      fact.startLine,
    ])).toEqual([
      ["docs/architecture(v2).md", "link", 3],
      ["docs/architecture(v2).md", "link", 3],
      ["images/logo&mark.png", "image", 5],
      ["docs/a&b.md", "link", 7],
      ["docs/a.md", "link", 8],
      ["docs/architecture(v2).md", "reference", 12],
      ["images/logo&mark.png", "reference", 13],
    ]);
  });
});
