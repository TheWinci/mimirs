import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  chunk,
  type CallFact,
  type ExportFact,
  type ImportFact,
  type SourceFact,
} from "@winci/bun-chunk";

const FIXTURES = join(import.meta.dir, "fixtures", "dart");

async function result(fixture: string) {
  const path = join(FIXTURES, fixture);
  return chunk(path, await Bun.file(path).text());
}

function calls(values: SourceFact[]): CallFact[] {
  return values.filter((fact): fact is CallFact => fact.kind === "call");
}

describe("Dart source fact bindings", () => {
  test("preserves imports, prefixes, conditional alternatives, exports, and parts", async () => {
    const values = (await result("modules.dart")).facts;
    expect(
      values
        .filter((fact): fact is ImportFact => fact.kind === "import")
        .map((fact) => [fact.source, fact.imported, fact.local]),
    ).toEqual([
      ["dart:async", "*", null],
      ["package:app/service.dart", "*", "service"],
      ["src/optional.dart", "*", null],
      ["src/io.dart", "conditional", null],
      ["worker.dart", "part", null],
    ]);
    expect(
      values.filter((fact): fact is ExportFact => fact.kind === "export"),
    ).toEqual([
      expect.objectContaining({
        exported: "Api",
        local: "Api",
        source: "src/api.dart",
      }),
    ]);
    expect((await result("part.dart")).facts[0]).toMatchObject({
      kind: "import",
      source: "app.main",
      imported: "part of",
      owner: null,
    });
  });

  test("binds import prefixes without guessing unprefixed libraries", async () => {
    expect(
      calls((await result("modules.dart")).facts).find(
        (fact) => fact.callee === "service.start",
      )?.binding,
    ).toBe("import");
  });

  test("keeps fields, constructors, accessors, and methods distinct", async () => {
    const point = (await result("constructors.dart")).chunks[0]!;
    expect(
      point.children
        .filter((chunk) => chunk.name !== null)
        .map((chunk) => [chunk.name, chunk.kind]),
    ).toEqual([
      ["x", "field"],
      ["y", "field"],
      ["Point", "method"],
      ["Point.origin", "method"],
      ["Point.create", "method"],
      ["sum", "method"],
      ["value", "method"],
      ["parse", "method"],
    ]);
  });

  test("targets same-file constructors through their class chunk", async () => {
    expect(
      calls((await result("constructors.dart")).facts).find(
        (fact) => fact.callee === "Point.origin",
      )?.target,
    ).toMatchObject({ kind: "class", name: "Point" });
  });

  test("targets named top-level closures and local functions", async () => {
    const values = calls((await result("functions.dart")).facts);
    expect(
      values.find((fact) => fact.callee === "callback")?.target,
    ).toMatchObject({
      kind: "function",
      name: "callback",
    });
    expect(
      values.find((fact) => fact.callee === "nested")?.target,
    ).toMatchObject({
      kind: "function",
      name: "nested",
    });
  });

  test("binds parameters and closure captures without inventing missing names", async () => {
    const values = calls((await result("scope.dart")).facts);
    expect(values.find((fact) => fact.callee === "loader.load")?.binding).toBe(
      "local",
    );
    expect(
      values.find((fact) => fact.callee === "service.execute")?.binding,
    ).toBe("local");
    expect(values.find((fact) => fact.callee === "missing")?.binding).toBe(
      "unknown",
    );
  });

  test("preserves null-aware, chained, nested, and cascade call spelling", async () => {
    const values = calls((await result("calls.dart")).facts);
    expect(values.map((fact) => fact.callee)).toEqual([
      "service?.execute",
      "build",
      "build().start",
      "values.map",
      "values.map().toList",
      "transform",
      "Worker.create",
      "worker..prepare",
      "worker..start",
    ]);
    expect(
      values
        .filter((fact) => fact.callee.startsWith("worker.."))
        .every(
          (fact) => fact.binding === "local" && fact.owner?.name === "worker",
        ),
    ).toBe(true);
  });

  test("does not resolve an external constructor from spelling alone", async () => {
    expect(
      calls((await result("calls.dart")).facts).find(
        (fact) => fact.callee === "Worker.create",
      )?.binding,
    ).toBe("unknown");
  });

  test("excludes constructor-style annotations from runtime calls", async () => {
    expect(
      calls((await result("comments.dart")).facts).map((fact) => fact.callee),
    ).toEqual(["render"]);
  });

  test("emits exports only for explicit library export directives", async () => {
    expect(
      (await result("types.dart")).facts.some((fact) => fact.kind === "export"),
    ).toBe(false);
  });

  test("DART-L1 scopes loops, catches, destructuring, and patterns without leaks", async () => {
    const values = calls((await result("control-flow.dart")).facts);
    const selected = values.filter((fact) =>
      [
        "loop",
        "item",
        "left",
        "right",
        "error.report",
        "stack.toString",
        "first",
        "second",
        "selected",
        "matched",
        "chosen",
      ].includes(fact.callee)
    );
    expect(selected.map((fact) => [fact.callee, fact.startLine, fact.binding])).toEqual([
      ["loop", 20, "local"],
      ["loop", 22, "unknown"],
      ["item", 25, "local"],
      ["item", 27, "unknown"],
      ["left", 30, "local"],
      ["right", 31, "local"],
      ["left", 33, "unknown"],
      ["error.report", 38, "local"],
      ["stack.toString", 39, "local"],
      ["error.report", 41, "unknown"],
      ["stack.toString", 42, "unknown"],
      ["first", 45, "local"],
      ["second", 46, "local"],
      ["selected", 49, "local"],
      ["selected", 51, "unknown"],
      ["matched", 55, "local"],
      ["matched", 60, "unknown"],
      ["chosen", 63, "local"],
      ["chosen", 66, "unknown"],
    ]);
  });

  test("DART-L2 respects initializer timing, reassignment, nested scope, and write negatives", async () => {
    const values = calls((await result("shadowing.dart")).facts);
    const selected = values.filter((fact) =>
      ["Target", "target", "nested", "receiver", "values"].includes(fact.callee)
    );
    expect(selected.map((fact) => [fact.callee, fact.startLine, fact.binding])).toEqual([
      ["Target", 7, "source-chunk"],
      ["target", 8, "local"],
      ["target", 11, "local"],
      ["nested", 15, "local"],
      ["nested", 17, "unknown"],
      ["receiver", 20, "unknown"],
      ["values", 22, "unknown"],
    ]);
    expect(selected[0]?.target).toMatchObject({ kind: "function", name: "Target" });
  });

  test("DART-E1 applies ordered show/hide combinators to explicit names", async () => {
    const values = (await result("combinators.dart")).facts;
    expect(values.filter((fact): fact is ImportFact => fact.kind === "import").map((fact) => [
      fact.source,
      fact.imported,
      fact.local,
    ])).toEqual([
      ["alpha.dart", "One", "One"],
      ["beta.dart", "*", "beta"],
    ]);
    expect(values.filter((fact): fact is ExportFact => fact.kind === "export").map((fact) => [
      fact.source,
      fact.exported,
    ])).toEqual([
      ["gamma.dart", "Public"],
      ["delta.dart", "*"],
    ]);
    expect(calls(values).map((fact) => [fact.callee, fact.binding])).toEqual([
      ["One", "import"],
      ["Two", "unknown"],
      ["beta.Start", "import"],
    ]);
  });

  test("DART-E2 covers extension types, dot shorthands, and generic calls", async () => {
    const value = await result("modern.dart");
    expect(value.chunks[0]).toMatchObject({ kind: "class", name: "Identifier" });
    const values = calls(value.facts);
    expect(values.find((fact) => fact.callee === "value.toString")).toMatchObject({
      binding: "local",
      owner: { kind: "method", name: "render" },
    });
    expect(values.filter((fact) => fact.callee.startsWith(".")).map((fact) => [
      fact.callee,
      fact.binding,
    ])).toEqual([
      [".parse", "unknown"],
      [".new", "unknown"],
      [".parse", "unknown"],
      [".parse().abs", "unknown"],
    ]);
    expect(values.find((fact) => fact.callee === "identity")?.target).toMatchObject({
      kind: "function",
      name: "identity",
    });
    expect(values.some((fact) => fact.startLine === 16)).toBe(false);
  });

  test("DART-S1 retains deferred and hide-only dependencies conservatively", async () => {
    const values = (await result("combinators.dart")).facts;
    expect(values).toContainEqual(expect.objectContaining({
      kind: "import",
      source: "beta.dart",
      imported: "*",
      local: "beta",
    }));
    expect(values).toContainEqual(expect.objectContaining({
      kind: "export",
      source: "delta.dart",
      exported: "*",
    }));
  });
});
