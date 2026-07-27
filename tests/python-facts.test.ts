import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { chunk, type CallFact, type ImportFact } from "@winci/bun-chunk";

const FIXTURES = join(import.meta.dir, "fixtures", "python");

async function result(fixture: string) {
  const path = join(FIXTURES, fixture);
  return chunk(path, await Bun.file(path).text());
}

async function facts(fixture: string) {
  return (await result(fixture)).facts;
}

function calls(values: Awaited<ReturnType<typeof facts>>): CallFact[] {
  return values.filter((fact): fact is CallFact => fact.kind === "call");
}

describe("Python source fact bindings", () => {
  test("treats stubs as declarations with imports but no executable calls", async () => {
    const value = await result("stubs.pyi");
    expect(value.language).toBe("python");
    expect(value.facts.every((fact) => fact.kind === "import")).toBe(true);
    expect(
      value.facts.some(
        (fact) => fact.kind === "import" && fact.imported === "TypeVar",
      ),
    ).toBe(true);
    const reader = value.chunks.find((chunk) => chunk.name === "Reader")!;
    expect(
      reader.children.filter((chunk) => chunk.kind === "method").length,
    ).toBe(3);
  });

  test("distinguishes parameters, annotations, defaults, and imported names", async () => {
    const values = calls(await facts("scope.py"));

    expect(
      values.map((fact) => [fact.callee, fact.startLine, fact.binding]),
    ).toEqual([
      ["run", 5, "local"],
      ["Runner", 5, "unknown"],
      ["default_runner", 5, "unknown"],
      ["run", 9, "import"],
    ]);
  });

  test("resolves nested functions and classes to exact source chunks", async () => {
    const functionCalls = calls(await facts("functions.py"));
    const inner = functionCalls.find((fact) => fact.callee === "inner");
    expect(inner).toMatchObject({
      binding: "source-chunk",
      target: { kind: "function", name: "inner" },
    });

    const nestingCalls = calls(await facts("nesting.py"));
    const product = nestingCalls.find((fact) => fact.callee === "Product");
    expect(product).toMatchObject({
      binding: "source-chunk",
      target: { kind: "class", name: "Product" },
    });
  });

  test("marks imports guarded by TYPE_CHECKING", async () => {
    const imports = (await facts("type-checking.py")).filter(
      (fact): fact is ImportFact => fact.kind === "import",
    );

    expect(imports.map((fact) => [fact.local, fact.typeOnly])).toEqual([
      ["TYPE_CHECKING", false],
      ["typing", false],
      ["User", true],
      ["ServiceType", true],
      ["RuntimeUser", false],
    ]);
  });

  test("assigns calls in class attributes to field chunks", async () => {
    const [buildCache] = calls(await facts("class-fields.py"));
    expect(buildCache).toMatchObject({
      callee: "build_cache",
      owner: { kind: "field", name: "cache" },
    });
  });

  test("PY-L1/L2 binds lambda, comprehension, loop, with, and except names", async () => {
    const values = calls(await facts("lexical-bindings.py"));
    expect(
      values.map((fact) => [fact.callee, fact.startLine, fact.binding]),
    ).toEqual([
      ["callback", 2, "local"],
      ["callback", 3, "unknown"],
      ["callback", 3, "local"],
      ["factory", 5, "local"],
      ["factory", 6, "local"],
      ["factory", 6, "local"],
      ["builder", 7, "local"],
      ["value", 9, "local"],
      ["resources.entries", 10, "local"],
      ["worker", 12, "local"],
      ["inner", 14, "local"],
      ["outer", 16, "local"],
      ["factory", 18, "unknown"],
      ["runner", 21, "local"],
      ["runner", 22, "local"],
      ["resources.open", 24, "local"],
      ["resources.pair", 24, "local"],
      ["opened", 25, "local"],
      ["left", 26, "local"],
      ["right", 27, "local"],
      ["opened", 28, "local"],
      ["resources.load", 31, "local"],
      ["error", 33, "local"],
      ["callback", 38, "unknown"],
      ["callback", 39, "local"],
    ]);
    expect(
      values.map((fact) => [fact.startLine, fact.owner?.name ?? null]).filter(
        ([line]) => line === 38 || line === 39,
      ),
    ).toEqual([
      [38, null],
      [39, "default_scope"],
    ]);
  });

  test("PY-L3 respects global and nonlocal directives without guessing rebound targets", async () => {
    const values = calls(await facts("rebindings.py"));
    expect(
      values.map((fact) => [fact.callee, fact.owner?.name, fact.binding]),
    ).toEqual([
      ["global_handler", "use_global", "import"],
      ["global_handler", "replace_global", "local"],
      ["handler", "inherited", "local"],
      ["handler", "replaced", "local"],
    ]);
    expect(values.every((fact) => fact.target === null)).toBe(true);
  });

  test("PY-E1 keeps conditional imports owned and their shared bindings ambiguous", async () => {
    const values = await facts("conditional-imports.py");
    const imports = values.filter(
      (fact): fact is ImportFact => fact.kind === "import",
    );
    expect(
      imports.map((fact) => [fact.source, fact.local, fact.owner?.name]),
    ).toEqual([
      ["package.fast", "selected", "choose"],
      ["package.slow", "selected", "choose"],
      ["package.optional", "load", "optional"],
      ["package.fallback", "load", "optional"],
    ]);
    expect(calls(values).map((fact) => [fact.callee, fact.binding])).toEqual([
      ["selected", "import"],
      ["load", "import"],
    ]);
  });

  test("PY-L4 assigns decorator, default, annotation, and base calls to evaluation scope", async () => {
    const values = calls(await facts("evaluation-scope.py"));
    expect(
      values.map((fact) => [fact.callee, fact.binding, fact.owner?.name ?? null]),
    ).toEqual([
      ["decorate", "import", null],
      ["register", "unknown", null],
      ["build_default", "import", null],
      ["return_type", "unknown", null],
      ["callback", "local", "configured"],
      ["base_class", "import", null],
      ["factory", "local", "value"],
      ["factory", "unknown", "run"],
    ]);
  });

  test("PY-L5 binds annotations, deletion, walrus targets, and match captures", async () => {
    const values = calls(await facts("patterns-and-walrus.py"));
    expect(
      values.map((fact) => [fact.callee, fact.startLine, fact.binding]),
    ).toEqual([
      ["annotated", 3, "local"],
      ["removed", 6, "local"],
      ["registry", 10, "unknown"],
      ["factories.pop", 12, "local"],
      ["chosen", 13, "local"],
      ["captured", 16, "local"],
      ["factories.build", 18, "local"],
      ["handler", 22, "local"],
      ["handler", 23, "local"],
      ["callback", 25, "local"],
      ["other", 26, "local"],
      ["first", 28, "local"],
      ["captured", 30, "local"],
    ]);
    expect(values.every((fact) => fact.owner?.name === "modern_binders")).toBe(true);
  });
});
