import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  chunk,
  type CallFact,
  type ExportFact,
  type ImportFact,
} from "@winci/bun-chunk";

const FIXTURES = join(import.meta.dir, "fixtures", "javascript");

async function result(fixture: string) {
  const path = join(FIXTURES, fixture);
  return chunk(path, await Bun.file(path).text());
}

describe("JavaScript module and JSX variants", () => {
  test("preserves ESM imports, exports, and calls in .mjs", async () => {
    const value = await result("esm-module.mjs");
    expect(value).toMatchObject({ language: "javascript", strategy: "ast" });
    expect(
      value.facts
        .filter((fact) => fact.kind === "export")
        .map((fact) => fact.exported),
    ).toEqual(["root", "locate", "default"]);
  });

  test("keeps JSX tags structural while retaining expression calls", async () => {
    const value = await result("component.jsx");
    const calls = value.facts.filter(
      (fact): fact is CallFact => fact.kind === "call",
    );
    expect(calls.map((fact) => fact.callee)).toEqual([
      "value.toUpperCase",
      "label",
      "track",
    ]);
    expect(
      calls.some((fact) => ["button", "Button"].includes(fact.callee)),
    ).toBe(false);
  });

  test("JSX-E1 preserves calls in every reviewed JSX expression context", async () => {
    const calls = (await result("jsx-expressions.jsx")).facts.filter(
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

  test("models literal CommonJS requires and named exports in .cjs", async () => {
    const value = await result("commonjs.cjs");
    expect(value).toMatchObject({ language: "javascript", strategy: "ast" });

    const imports = value.facts.filter(
      (fact): fact is ImportFact => fact.kind === "import",
    );
    expect(
      imports.map((fact) => [fact.source, fact.imported, fact.local]),
    ).toEqual([
      ["node:fs", "*", "fs"],
      ["node:path", "join", "joinPath"],
      ["node:path", "basename", "basename"],
      ["./register.cjs", null, null],
    ]);

    const calls = value.facts.filter(
      (fact): fact is CallFact => fact.kind === "call",
    );
    expect(calls.map((fact) => fact.callee)).toEqual([
      "require",
      "fs.readFileSync",
    ]);

    const exports = value.facts.filter(
      (fact): fact is ExportFact => fact.kind === "export",
    );
    expect(exports.map((fact) => [fact.exported, fact.local])).toEqual([
      ["read", "read"],
      ["join", "joinPath"],
      ["basename", "basename"],
    ]);
  });

  test("models module.exports as a CommonJS default export", async () => {
    const value = await result("default.cjs");
    expect(
      value.facts
        .filter((fact): fact is ExportFact => fact.kind === "export")
        .map((fact) => [fact.exported, fact.local]),
    ).toEqual([["default", "create"]]);
  });

  test("CJS-E1/E2 covers selected requires and explicit object exports", async () => {
    const value = await result("commonjs-exports.cjs");
    const imports = value.facts.filter(
      (fact): fact is ImportFact => fact.kind === "import",
    );
    expect(
      imports.slice(0, 3).map((fact) => [fact.source, fact.imported, fact.local]),
    ).toEqual([
      ["./dep.cjs", "picked", "picked"],
      ["./dep.cjs", "other", "other"],
      ["./dep.cjs", "computed", "computed"],
    ]);

    const exports = value.facts.filter(
      (fact): fact is ExportFact => fact.kind === "export",
    );
    expect(
      exports.map((fact) => [fact.exported, fact.local, fact.source]),
    ).toEqual([
      ["picked", "picked", null],
      ["renamed", "other", null],
      ["factory", "default", "./factory.cjs"],
      ["third", "third", "./dep.cjs"],
      ["computedObject", "computed", null],
      ["method", null, null],
    ]);

    const pickedCall = value.facts.find(
      (fact): fact is CallFact => fact.kind === "call" && fact.callee === "picked",
    );
    expect(pickedCall).toMatchObject({ binding: "import", owner: null });
  });

  test("CJS-E2 covers chained and statically computed exports without guessing dynamic APIs", async () => {
    const value = await result("commonjs-chained.cjs");
    expect(
      value.facts
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
      value.facts.some(
        (fact) => fact.kind === "export" &&
          ["dynamic", "defined", "aliased"].includes(fact.exported),
      ),
    ).toBe(false);
    expect(
      value.facts.some(
        (fact) => fact.kind === "call" && fact.callee === "Object.defineProperty",
      ),
    ).toBe(true);
  });

  test("CJS-E3 represents whole-module re-exports as named and default forwarding", async () => {
    const value = await result("commonjs-reexport.cjs");
    expect(
      value.facts
        .filter((fact): fact is ExportFact => fact.kind === "export")
        .map((fact) => [fact.exported, fact.local, fact.source]),
    ).toEqual([
      ["*", null, "./replacement.cjs"],
      ["default", "default", "./replacement.cjs"],
    ]);
  });

  test("CJS-L1 suppresses dependencies and exports for shadowed or reassigned globals", async () => {
    const value = await result("commonjs-shadowing.cjs");
    expect(
      value.facts
        .filter((fact): fact is ImportFact => fact.kind === "import")
        .map((fact) => fact.source),
    ).toEqual(["./real.cjs"]);
    expect(value.facts.some((fact) => fact.kind === "export")).toBe(false);

    const shadowedCall = value.facts.find(
      (fact): fact is CallFact =>
        fact.kind === "call" && fact.owner?.name === "shadowRequire",
    );
    expect(shadowedCall).toMatchObject({
      callee: "require",
      binding: "local",
      owner: { kind: "function", name: "shadowRequire" },
    });
    const lexicalCall = value.facts.find(
      (fact): fact is CallFact =>
        fact.kind === "call" && fact.callee === "require" &&
        fact.owner?.name === "lexicalRequire",
    );
    expect(lexicalCall).toMatchObject({ binding: "local" });
    const reassignedCall = value.facts.find(
      (fact): fact is CallFact => fact.kind === "call" && fact.owner?.name === "later",
    );
    expect(reassignedCall).toMatchObject({ callee: "require", binding: "unknown" });
  });
});
