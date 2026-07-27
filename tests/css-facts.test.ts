import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { chunk, type ImportFact } from "@winci/bun-chunk";

const FIXTURES = join(import.meta.dir, "fixtures", "css");

async function result(fixture: string) {
  const path = join(FIXTURES, fixture);
  return chunk(path, await Bun.file(path).text());
}

function imports(
  values: Awaited<ReturnType<typeof result>>["facts"],
): ImportFact[] {
  return values.filter((fact): fact is ImportFact => fact.kind === "import");
}

describe("CSS source facts", () => {
  test("preserves string and url stylesheet imports", async () => {
    expect(
      imports((await result("imports.css")).facts).map((fact) => [
        fact.source,
        fact.imported,
        fact.owner,
      ]),
    ).toEqual([
      ["reset.css", "stylesheet", null],
      ["theme.css", "stylesheet", null],
    ]);
  });

  test("preserves static declaration resources and their selector owners", async () => {
    expect(
      imports((await result("assets.css")).facts).map((fact) => [
        fact.source,
        fact.imported,
        fact.owner?.name,
      ]),
    ).toEqual([
      ["images/hero.png", "asset:url", ".hero"],
      ["cursors/pointer.cur", "asset:url", ".hero"],
      ["images/photo.png", "asset:url", ".gallery"],
      ["images/photo@2x.png", "asset:url", ".gallery"],
      ["https://cdn.example.com/pattern.svg", "asset:url", ".remote"],
    ]);
  });

  test("owns font resources by the enclosing at-rule", async () => {
    const font = imports((await result("at-rules.css")).facts)[0]!;
    expect([font.source, font.owner?.kind, font.owner?.name]).toEqual([
      "fonts/inter.woff2",
      "rule",
      "@font-face",
    ]);
  });

  test("rejects variables, fragments, data URIs, and non-resource functions", async () => {
    expect((await result("dynamic.css")).facts).toEqual([]);
  });

  test("does not treat namespace URIs or CSS functions as calls", async () => {
    const values = [
      ...(await result("imports.css")).facts,
      ...(await result("dynamic.css")).facts,
    ];
    expect(imports(values).some((fact) => fact.source.includes("w3.org"))).toBe(
      false,
    );
    expect(values.some((fact) => fact.kind === "call")).toBe(false);
  });

  test("does not fabricate CSS export facts", async () => {
    expect(
      (await result("selectors.css")).facts.some(
        (fact) => fact.kind === "export",
      ),
    ).toBe(false);
  });

  test("CSS-E1 preserves direct and URL image-set candidates", async () => {
    expect(imports((await result("image-set.css")).facts).map((fact) => [
      fact.source,
      fact.imported,
      fact.owner?.name ?? null,
    ])).toEqual([
      ["images/hero.png", "asset:image-set", ".hero"],
      ["images/hero@2x.png", "asset:url", ".hero"],
      ["images/legacy.png", "asset:image-set", ".legacy"],
    ]);
  });
});
