import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { chunk, type CallFact, type ImportFact } from "@winci/bun-chunk";

const FIXTURES = join(import.meta.dir, "fixtures", "scala");

async function facts(fixture: string) {
  const path = join(FIXTURES, fixture);
  return (await chunk(path, await Bun.file(path).text())).facts;
}

function calls(values: Awaited<ReturnType<typeof facts>>): CallFact[] {
  return values.filter((fact): fact is CallFact => fact.kind === "call");
}

describe("Scala source fact bindings", () => {
  test("preserves Scala 2/3 selectors, aliases, hides, wildcards, and givens", async () => {
    const imports = (await facts("imports.scala")).filter(
      (fact): fact is ImportFact => fact.kind === "import",
    );
    expect(
      imports.map((fact) => [fact.source, fact.imported, fact.local]),
    ).toEqual([
      ["scala.collection", "mutable", "mutable"],
      ["scala.util", "Try", "Try"],
      ["scala.util", "Success", "Ok"],
      ["scala.util", "Failure", null],
      ["helpers", "*", null],
      ["scala.concurrent", "Future", "Async"],
      ["scala.concurrent", "*", null],
      ["ordering", "given", null],
      ["ordering", "given Ordering", null],
      ["ordering", "given Conversion", null],
      ["ordering", "*", null],
    ]);
    expect(
      calls(await facts("imports.scala")).map((fact) => [
        fact.callee,
        fact.binding,
      ]),
    ).toEqual([
      ["Ok", "import"],
      ["mutable.Map", "import"],
      ["Async.successful", "import"],
      ["unknownWildcard", "unknown"],
    ]);
  });

  test("targets curried methods and same-file constructors conservatively", async () => {
    const values = calls(await facts("calls.scala"));
    expect(
      values
        .filter((fact) => fact.callee.startsWith("helper"))
        .map((fact) => [fact.callee, fact.binding, fact.target?.name]),
    ).toEqual([
      ["helper", "source-chunk", "helper"],
      ["helper(1)", "source-chunk", "helper"],
    ]);
    expect(
      values.find((fact) => fact.callee === "Worker")?.target,
    ).toMatchObject({ kind: "class", name: "Worker" });
    expect(values.find((fact) => fact.callee === "first +")?.binding).toBe(
      "local",
    );
    expect(values.find((fact) => fact.callee === "head ::")?.binding).toBe(
      "local",
    );
  });

  test("targets named lambdas and binds their parameters", async () => {
    const values = calls(await facts("functions.scala"));
    expect(
      values.find((fact) => fact.callee === "normalize")?.target,
    ).toMatchObject({ kind: "function", name: "normalize" });
    expect(
      values.find((fact) => fact.callee === "local")?.target,
    ).toMatchObject({ kind: "function", name: "local" });
    expect(values.find((fact) => fact.callee === "loader")?.binding).toBe(
      "local",
    );
  });

  test("binds direct Scala 3 aliases and isolates wildcard lookup", async () => {
    const values = await facts("scope.scala");
    expect(values[0]).toMatchObject({
      kind: "import",
      source: "vendor",
      imported: "Worker",
      local: "ImportedWorker",
    });
    expect(
      calls(values).find((fact) => fact.callee === "ImportedWorker.create")
        ?.binding,
    ).toBe("import");
    expect(
      calls(values).find((fact) => fact.callee === "callback")?.target,
    ).toMatchObject({ kind: "function", name: "callback" });
  });

  test("owns calls inside fields, givens, extensions, and enum methods", async () => {
    expect(
      calls(await facts("types.scala")).find(
        (fact) => fact.callee === "Client.create",
      )?.owner,
    ).toMatchObject({ kind: "field", name: "client" });
    const modern = calls(await facts("scala3.scala"));
    expect(
      modern.find((fact) => fact.callee === "compareState")?.owner,
    ).toMatchObject({ kind: "method", name: "compare" });
    expect(modern.find((fact) => fact.callee === "clean")?.owner).toMatchObject(
      { kind: "method", name: "normalized" },
    );
  });

  test("keeps sequential package clauses nested", async () => {
    expect(
      calls(await facts("packages.scala")).map((fact) => [
        fact.callee,
        fact.owner?.kind,
        fact.owner?.name,
      ]),
    ).toEqual([
      ["loadRoot", "variable", "RootValue"],
      ["loadNested", "field", "value"],
    ]);
  });

  test("does not fabricate exports or parameterless calls", async () => {
    const values = await facts("functions.scala");
    expect(values.some((fact) => fact.kind === "export")).toBe(false);
    expect(calls(values).some((fact) => fact.callee === "value.trim")).toBe(
      false,
    );
  });

  test("SCALA-L1 scopes comprehension, lambda, match, catch, and tuple binders", async () => {
    const values = calls(await facts("control-flow.scala"));
    const binding = (line: number, callee: string) =>
      values.find((fact) => fact.startLine === line && fact.callee === callee)?.binding;

    expect([
      binding(12, "entry"),
      binding(13, "prepared"),
      binding(16, "first"),
      binding(17, "second"),
      binding(25, "left"),
      binding(26, "right"),
      binding(32, "found"),
      binding(33, "fallback"),
      binding(38, "failure.getMessage"),
    ]).toEqual(Array(9).fill("local"));
    expect([
      binding(18, "first"),
      binding(20, "entry"),
      binding(21, "prepared"),
      binding(28, "current"),
      binding(29, "left"),
      binding(34, "found"),
      binding(39, "failure.getMessage"),
    ]).toEqual(Array(7).fill("unknown"));
  });

  test("SCALA-L2 respects constructor parameters, timing, and direct reassignment", async () => {
    const values = calls(await facts("control-flow.scala"));
    expect(values.find((fact) => fact.startLine === 42)).toMatchObject({
      callee: "build",
      binding: "local",
      owner: { kind: "field", name: "current" },
    });
    expect(values.filter((fact) => [50, 52, 55, 57, 60].includes(fact.startLine)).map(
      (fact) => [fact.startLine, fact.callee, fact.binding, fact.target?.name ?? null],
    )).toEqual([
      [50, "before", "unknown", null],
      [52, "before", "source-chunk", "before"],
      [55, "callback", "source-chunk", "callback"],
      [57, "callback", "local", null],
      [60, "holder.callback", "local", null],
    ]);
  });

  test("SCALA-E1 keeps eta-expanded and parameterless references non-executable", async () => {
    expect(calls(await facts("control-flow.scala")).some(
      (fact) => [46, 47].includes(fact.startLine),
    )).toBe(false);
  });

  test("SC-L1 applies explicit lexical scope without assuming a script host", async () => {
    expect(calls(await facts("script-scope.sc")).map((fact) => [
      fact.callee,
      fact.startLine,
      fact.binding,
    ])).toEqual([
      ["make", 3, "source-chunk"],
      ["callback", 4, "source-chunk"],
      ["make", 7, "source-chunk"],
      ["nested", 8, "source-chunk"],
      ["make", 10, "source-chunk"],
      ["nested", 11, "unknown"],
    ]);
    expect(calls(await facts("script-scope.sc")).some((fact) => fact.startLine === 13)).toBe(
      false,
    );
  });
});
