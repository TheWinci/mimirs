import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  chunk,
  type CallFact,
  type ExportFact,
  type ImportFact,
} from "@winci/bun-chunk";

const FIXTURES = join(import.meta.dir, "fixtures", "typescript");

async function result(fixture: string) {
  const path = join(FIXTURES, fixture);
  return chunk(path, await Bun.file(path).text());
}

describe("TypeScript module and JSX variants", () => {
  test("preserves ESM imports, exports, and calls in .mts", async () => {
    const value = await result("esm-module.mts");
    expect(value).toMatchObject({ language: "typescript", strategy: "ast" });
    expect(
      value.facts
        .filter((fact): fact is ImportFact => fact.kind === "import")
        .map((fact) => [fact.source, fact.imported, fact.typeOnly]),
    ).toEqual([
      ["node:fs", "Stats", true],
      ["node:path", "resolve", false],
    ]);
    expect(
      value.facts
        .filter((fact) => fact.kind === "export")
        .map((fact) => fact.exported),
    ).toEqual(["Stats", "config", "default"]);
  });

  test("keeps JSX elements structural and extracts only expression calls", async () => {
    const value = await result("component.tsx");
    const calls = value.facts.filter(
      (fact): fact is CallFact => fact.kind === "call",
    );
    expect(calls.map((fact) => fact.callee)).toEqual([
      "value.toUpperCase",
      "format",
    ]);
    expect(
      calls.some((fact) => ["article", "h2", "Card"].includes(fact.callee)),
    ).toBe(false);
  });

  test("TSX-E1 preserves calls in every reviewed JSX expression context", async () => {
    const calls = (await result("jsx-expressions.tsx")).facts.filter(
      (fact): fact is CallFact => fact.kind === "call",
    );
    expect(calls.map((fact) => [fact.callee, fact.binding, fact.owner?.name])).toEqual([
      ["makeProps", "import", "propsFor"],
      ["items.at", "local", "Gallery"],
      ["propsFor", "source-chunk", "Gallery"],
      ["formatTitle", "import", "Gallery"],
      ["onSelect", "local", "Gallery"],
      ["items.map", "local", "Gallery"],
      ["renderItem", "import", "Gallery"],
    ]);
    expect(
      calls.some((fact) => ["Card", "Card.Header", "Fragment"].includes(fact.callee)),
    ).toBe(false);
  });

  test("models TypeScript CommonJS imports and export assignment in .cts", async () => {
    const value = await result("commonjs.cts");
    expect(value).toMatchObject({ language: "typescript", strategy: "ast" });

    expect(
      value.facts
        .filter((fact): fact is ImportFact => fact.kind === "import")
        .map((fact) => [fact.source, fact.imported, fact.local]),
    ).toEqual([
      ["node:path", "*", "path"],
      ["node:fs", "*", "fs"],
    ]);
    expect(
      value.facts
        .filter((fact): fact is CallFact => fact.kind === "call")
        .map((fact) => fact.callee),
    ).toEqual(["fs.readFileSync", "path.resolve"]);
    expect(
      value.facts
        .filter((fact): fact is ExportFact => fact.kind === "export")
        .map((fact) => [fact.exported, fact.local]),
    ).toEqual([["default", "load"]]);
  });

  test("CJS-E1/E2 applies selected requires and object exports to .cts", async () => {
    const value = await result("commonjs-exports.cts");
    expect(
      value.facts
        .filter((fact): fact is ImportFact => fact.kind === "import")
        .slice(0, 3)
        .map((fact) => [fact.source, fact.imported, fact.local]),
    ).toEqual([
      ["./dep.cjs", "picked", "picked"],
      ["./dep.cjs", "other", "other"],
      ["./dep.cjs", "computed", "computed"],
    ]);
    expect(
      value.facts
        .filter((fact): fact is ExportFact => fact.kind === "export")
        .map((fact) => [fact.exported, fact.local, fact.source]),
    ).toEqual([
      ["picked", "picked", null],
      ["renamed", "other", null],
      ["factory", "default", "./factory.cjs"],
      ["third", "third", "./dep.cjs"],
      ["computedObject", "computed", null],
      ["method", null, null],
    ]);
    expect(
      value.facts.find(
        (fact): fact is CallFact => fact.kind === "call" && fact.callee === "picked",
      ),
    ).toMatchObject({ binding: "import", owner: null });
  });

  test("CJS-E2/E3 applies chained exports and exact re-exports to .cts", async () => {
    const chained = await result("commonjs-chained.cts");
    expect(
      chained.facts
        .filter((fact): fact is ExportFact => fact.kind === "export")
        .map((fact) => [fact.exported, fact.local, fact.source]),
    ).toEqual([
      ["first", "picked", null],
      ["second", "picked", null],
      ["alias", "picked", "./dep.cjs"],
      ["literal", "computed", null],
      ["literalAlias", "picked", null],
      ["computedModule", "picked", null],
    ]);
    expect(
      chained.facts.some(
        (fact) => fact.kind === "export" &&
          ["dynamic", "defined", "aliased"].includes(fact.exported),
      ),
    ).toBe(false);

    const reexport = await result("commonjs-reexport.cts");
    expect(
      reexport.facts
        .filter((fact): fact is ExportFact => fact.kind === "export")
        .map((fact) => [fact.exported, fact.local, fact.source]),
    ).toEqual([
      ["*", null, "./replacement.cjs"],
      ["default", "default", "./replacement.cjs"],
    ]);
  });

  test("CJS-L1 applies CommonJS global shadowing and reassignment rules to .cts", async () => {
    const value = await result("commonjs-shadowing.cts");
    expect(
      value.facts
        .filter((fact): fact is ImportFact => fact.kind === "import")
        .map((fact) => fact.source),
    ).toEqual(["./real.cjs"]);
    expect(value.facts.some((fact) => fact.kind === "export")).toBe(false);
    expect(
      value.facts.find(
        (fact): fact is CallFact =>
          fact.kind === "call" && fact.owner?.name === "shadowRequire",
      ),
    ).toMatchObject({
      callee: "require",
      binding: "local",
      owner: { kind: "function", name: "shadowRequire" },
    });
    expect(
      value.facts.find(
        (fact): fact is CallFact =>
          fact.kind === "call" && fact.callee === "require" &&
          fact.owner?.name === "lexicalRequire",
      ),
    ).toMatchObject({ binding: "local" });
  });
});
