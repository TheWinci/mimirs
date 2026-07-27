import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { chunk, type CallFact, type ImportFact } from "@winci/bun-chunk";

const FIXTURES = join(import.meta.dir, "fixtures", "csharp");

async function facts(fixture: string) {
  const path = join(FIXTURES, fixture);
  return (await chunk(path, await Bun.file(path).text())).facts;
}

function calls(values: Awaited<ReturnType<typeof facts>>): CallFact[] {
  return values.filter((fact): fact is CallFact => fact.kind === "call");
}

describe("C# source fact bindings", () => {
  test("preserves global, static, alias, and namespace using forms", async () => {
    const values = await facts("imports.cs");
    const imports = values.filter((fact): fact is ImportFact => fact.kind === "import");
    expect(imports.map((fact) => [
      fact.source,
      fact.local,
      fact.static,
      fact.global,
    ])).toEqual([
      ["System", null, false, true],
      ["System.Math", null, true, false],
      ["System.Text", "Text", false, false],
      ["Project.Services", null, false, false],
    ]);
    expect(calls(values).map((fact) => [fact.callee, fact.binding])).toEqual([
      ["Abs", "unknown"],
      ["Text.StringBuilder", "import"],
    ]);
  });

  test("binds parameters, fields, aliases, local functions, lambdas, and local types", async () => {
    const values = calls(await facts("scope.cs"));
    expect(values.map((fact) => [fact.callee, fact.binding])).toEqual([
      ["CreateService", "unknown"],
      ["loader", "local"],
      ["Helper", "source-chunk"],
      ["service.Execute", "local"],
      ["WorkerAlias.Create", "import"],
      ["value.Trim", "local"],
      ["normalize", "source-chunk"],
      ["Clean", "unknown"],
      ["Local", "source-chunk"],
      ["Worker", "source-chunk"],
      ["Build", "unknown"],
      ["Worker", "source-chunk"],
      ["worker?.Execute", "local"],
      ["worker!.Execute", "local"],
      ["Worker", "source-chunk"],
    ]);
    expect(values.find((fact) => fact.callee === "normalize")?.target).toMatchObject({
      kind: "function",
      name: "normalize",
    });
    expect(values.find((fact) => fact.callee === "Local")?.target).toMatchObject({
      kind: "function",
      name: "Local",
    });
  });

  test("assigns calls in accessors, constructors, destructors, and operators", async () => {
    const values = calls(await facts("members.cs"));
    expect(values.find((fact) => fact.callee === "Register")?.owner).toMatchObject({
      kind: "event",
      name: "Custom",
    });
    expect(values.find((fact) => fact.callee === "Save")?.owner).toMatchObject({
      kind: "property",
      name: "this",
    });
    expect(values.find((fact) => fact.callee === "this")?.binding).toBe("local");
    expect(values.find((fact) => fact.callee === "base")?.binding).toBe("local");
    expect(values.find((fact) => fact.callee === "Convert")?.owner).toMatchObject({
      kind: "method",
      name: "explicit operator int",
    });
  });

  test("keeps namespace aliases owned by their declaration scope", async () => {
    const values = await facts("namespaces.cs");
    expect(values[0]).toMatchObject({
      kind: "import",
      local: "Local",
      owner: { kind: "module", name: "Fixtures.Outer" },
    });
    expect(calls(values)[0]).toMatchObject({ callee: "Local.Start", binding: "import" });
  });

  test("binds class and record primary-constructor parameters", async () => {
    expect(calls(await facts("primary-constructors.cs")).map((fact) => [
      fact.callee,
      fact.binding,
      fact.owner?.name,
    ])).toEqual([
      ["service.Execute", "local", "Run"],
      ["value.Trim", "local", "Run"],
      ["factory", "local", "Build"],
    ]);
  });

  test("does not assign an arbitrary target to an overload set", async () => {
    expect(calls(await facts("overloads.cs"))[0]).toMatchObject({
      callee: "Dispatch",
      binding: "local",
      target: null,
    });
  });

  test("does not fabricate export facts from C# accessibility", async () => {
    expect((await facts("types.cs")).some((fact) => fact.kind === "export")).toBe(false);
  });

  test("CS-L1 scopes loops, resources, catches, and patterns without leaks", async () => {
    const values = calls(await facts("control-flow.cs"));
    const selected = values.filter((fact) =>
      [
        "loop",
        "item",
        "resource.Dispose",
        "error.IsExpected",
        "error.Report",
        "selected",
        "matched",
        "repeated",
      ].includes(fact.callee)
    );
    expect(selected.map((fact) => [fact.callee, fact.startLine, fact.binding])).toEqual([
      ["loop", 30, "local"],
      ["loop", 32, "unknown"],
      ["item", 36, "local"],
      ["item", 38, "unknown"],
      ["resource.Dispose", 42, "local"],
      ["resource.Dispose", 44, "unknown"],
      ["error.IsExpected", 50, "local"],
      ["error.Report", 52, "local"],
      ["error.Report", 54, "unknown"],
      ["selected", 58, "local"],
      ["selected", 60, "unknown"],
      ["matched", 65, "local"],
      ["matched", 68, "unknown"],
      ["repeated", 72, "local"],
      ["repeated", 75, "unknown"],
    ]);
  });

  test("CS-L2 handles deconstruction, out variables, query ranges, and extern aliases", async () => {
    const values = calls(await facts("bindings.cs"));
    const selected = values.filter((fact) =>
      [
        "first",
        "second",
        "left",
        "right",
        "result",
        "item.Render",
        "other.Render",
        "match.IsReady",
        "match.Render",
        "projected.Render",
        "Grid::Tools.Factory.Create",
      ].includes(fact.callee)
    );
    expect(selected.map((fact) => [fact.callee, fact.startLine, fact.binding])).toEqual([
      ["first", 31, "local"],
      ["second", 32, "local"],
      ["left", 36, "local"],
      ["right", 37, "local"],
      ["left", 39, "unknown"],
      ["result", 43, "local"],
      ["result", 45, "local"],
      ["item.Render", 49, "local"],
      ["other.Render", 51, "local"],
      ["match.IsReady", 54, "local"],
      ["match.Render", 55, "local"],
      ["projected.Render", 57, "local"],
      ["item.Render", 58, "unknown"],
      ["Grid::Tools.Factory.Create", 60, "local"],
    ]);
  });

  test("CS-L3 respects declaration order, grouped declarations, and block scope", async () => {
    const values = calls(await facts("shadowing.cs"));
    const selected = values.filter((fact) =>
      [
        "Target",
        "target",
        "first",
        "second",
        "nested",
        "receiver",
        "values",
      ].includes(fact.callee)
    );
    expect(selected.map((fact) => [fact.callee, fact.startLine, fact.binding])).toEqual([
      ["Target", 12, "source-chunk"],
      ["target", 13, "local"],
      ["target", 16, "local"],
      ["first", 19, "local"],
      ["second", 20, "local"],
      ["nested", 24, "local"],
      ["nested", 26, "unknown"],
      ["receiver", 29, "unknown"],
      ["values", 31, "unknown"],
    ]);
    expect(selected[0]?.target).toMatchObject({
      kind: "method",
      name: "Target",
      startLine: 8,
    });
  });

  test("CS-E1 keeps method groups non-executable", async () => {
    expect(calls(await facts("bindings.cs")).some((fact) => fact.startLine === 62)).toBe(false);
  });
});
