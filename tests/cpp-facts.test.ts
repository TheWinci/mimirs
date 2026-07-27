import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { chunk, parse, type CallFact, type ImportFact } from "@winci/bun-chunk";

const FIXTURES = join(import.meta.dir, "fixtures", "cpp");

async function facts(fixture: string) {
  const path = join(FIXTURES, fixture);
  return (await chunk(path, await Bun.file(path).text())).facts;
}

function calls(values: Awaited<ReturnType<typeof facts>>): CallFact[] {
  return values.filter((fact): fact is CallFact => fact.kind === "call");
}

describe("C++ source fact bindings", () => {
  test("preserves includes and respects macro undefinition", async () => {
    const values = await facts("preprocessor.cpp");
    const imports = values.filter((fact): fact is ImportFact => fact.kind === "import");
    expect(imports.map((fact) => fact.source)).toEqual(["<vector>", "\"local.hpp\""]);
    expect(calls(values).map((fact) => [fact.callee, fact.binding])).toEqual([
      ["APPLY", "source-chunk"],
      ["TEMPORARY", "unknown"],
    ]);
  });

  test("projects namespace aliases and using declarations without resolving wildcards", async () => {
    const values = await facts("types.cpp");
    const imports = values.filter((fact): fact is ImportFact => fact.kind === "import");
    expect(imports.map((fact) => [fact.source, fact.imported, fact.local])).toEqual([
      ["app::core", "*", "alias"],
      ["app::core", "Worker", "Worker"],
      ["std", "*", null],
    ]);
    expect(calls(values).map((fact) => [fact.callee, fact.binding])).toEqual([
      ["Worker::start", "import"],
      ["alias::run", "import"],
      ["move", "unknown"],
    ]);
  });

  test("binds parameters, members, overload sets, lambdas, and local types", async () => {
    const values = calls(await facts("calls.cpp"));
    expect(values.map((fact) => [fact.callee, fact.binding])).toEqual([
      ["helper", "source-chunk"],
      ["service.run", "local"],
      ["callback", "local"],
      ["this->method", "local"],
      ["configure", "local"],
      ["Type::create", "unknown"],
      ["factory", "unknown"],
      ["factory().start", "unknown"],
      ["nested", "unknown"],
      ["local", "source-chunk"],
      ["value.clean", "local"],
      ["normalize", "source-chunk"],
      ["Worker", "unknown"],
      ["build", "unknown"],
      ["Calls", "source-chunk"],
    ]);
    expect(values.find((fact) => fact.callee === "normalize")?.target).toMatchObject({
      kind: "function",
      name: "normalize",
    });
    expect(values.at(-1)?.target).toMatchObject({ kind: "class", name: "Calls" });
  });

  test("resolves free functions and namespace-scope callable variables", async () => {
    const values = calls(await facts("functions.cpp"));
    expect(values.map((fact) => [fact.callee, fact.binding])).toEqual([
      ["create", "unknown"],
      ["compute", "unknown"],
      ["callback", "local"],
      ["declared", "source-chunk"],
      ["add", "source-chunk"],
    ]);
    expect(values.find((fact) => fact.callee === "compute")?.owner).toMatchObject({
      kind: "constant",
      name: "LIMIT",
    });
  });

  test("prefers an exact template specialization", async () => {
    const [identity] = calls(await facts("templates.cpp"));
    expect(identity).toMatchObject({
      callee: "identity<int>",
      binding: "source-chunk",
      target: { kind: "function", name: "identity<int>", startLine: 17 },
    });
  });

  test("targets same-file classes from out-of-class method definitions", async () => {
    const values = calls(await facts("classes.cpp"));
    expect(values.find((fact) => fact.callee === "service_.execute")).toMatchObject({
      binding: "local",
      owner: { kind: "method", name: "run" },
    });
    expect(values.find((fact) => fact.callee === "Worker")?.target).toMatchObject({
      kind: "class",
      name: "Worker",
    });
    expect(values.find((fact) => fact.callee === "Worker")?.owner).toMatchObject({
      kind: "method",
      name: "Worker::create",
    });
  });

  test("does not fabricate export facts from C++ linkage", async () => {
    expect((await facts("api.hpp")).some((fact) => fact.kind === "export")).toBe(false);
  });

  test("CXX-L1 scopes control-flow declarations and patterns without leaks", async () => {
    const values = calls(await facts("control-flow.cpp"));
    const selected = values.filter((fact) =>
      ["loop", "item", "first", "second", "handler", "next", "error.handle"].includes(
        fact.callee,
      )
    );
    expect(selected.map((fact) => [fact.callee, fact.startLine, fact.binding])).toEqual([
      ["loop", 11, "local"],
      ["loop", 13, "unknown"],
      ["item", 16, "local"],
      ["item", 18, "unknown"],
      ["first", 21, "local"],
      ["second", 22, "local"],
      ["first", 24, "unknown"],
      ["handler", 27, "local"],
      ["handler", 29, "unknown"],
      ["next", 32, "local"],
      ["next", 34, "unknown"],
      ["error.handle", 39, "local"],
      ["error.handle", 41, "unknown"],
    ]);
    expect(values.filter((fact) => fact.callee === "make").map((fact) => [
      fact.startLine,
      fact.owner?.name ?? null,
    ])).toEqual([
      [10, "loop"],
      [10, "control_flow"],
      [26, "handler"],
      [31, "next"],
    ]);
  });

  test("CXX-L2 respects timing, reassignment, grouped declarations, and negatives", async () => {
    const values = calls(await facts("shadowing.cpp"));
    const selected = values.filter((fact) =>
      ["target", "first", "second", "nested", "object", "values"].includes(fact.callee)
    );
    expect(selected.map((fact) => [fact.callee, fact.startLine, fact.binding])).toEqual([
      ["target", 7, "source-chunk"],
      ["target", 8, "local"],
      ["target", 11, "local"],
      ["first", 14, "local"],
      ["second", 15, "local"],
      ["nested", 19, "local"],
      ["nested", 21, "unknown"],
      ["object", 24, "unknown"],
      ["values", 26, "unknown"],
    ]);
    expect(selected[0]?.target).toMatchObject({
      kind: "function",
      name: "target",
      startLine: 4,
    });
  });

  test("CXX-L3 keeps conditional macro definitions branch-local", async () => {
    const values = calls(await facts("conditional-macros.cpp"));
    expect(values.map((fact) => [
      fact.startLine,
      fact.binding,
      fact.target?.startLine ?? null,
    ])).toEqual([
      [4, "source-chunk", 2],
      [9, "source-chunk", 7],
      [14, "unknown", null],
    ]);
  });

  test("CXX-G1 pins the bundled grammar's C++20 module recovery gap", async () => {
    const tree = await parse("import core;\nexport module app;\n", "cpp");
    if (!tree) throw new Error("C++ parser returned no syntax tree");
    expect(tree.rootNode.hasError).toBe(true);
    expect(tree.rootNode.namedChildren.map((node) => node.type)).toEqual([
      "declaration",
      "declaration",
    ]);
  });
});
