import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { chunk, parse, type CallFact, type ImportFact } from "@winci/bun-chunk";

const FIXTURES = join(import.meta.dir, "fixtures", "zig");

async function facts(fixture: string) {
  const path = join(FIXTURES, fixture);
  return (await chunk(path, await Bun.file(path).text())).facts;
}

function calls(values: Awaited<ReturnType<typeof facts>>): CallFact[] {
  return values.filter((fact): fact is CallFact => fact.kind === "call");
}

describe("Zig source fact bindings", () => {
  test("extracts literal imports and C includes without guessing dynamic imports", async () => {
    const values = await facts("imports.zig");
    expect(
      values
        .filter((fact): fact is ImportFact => fact.kind === "import")
        .map((fact) => [fact.source, fact.imported, fact.local]),
    ).toEqual([
      ["std", "*", "std"],
      ["local.zig", "*", "local"],
      ["stdio.h", "c-header", "c"],
    ]);
    expect(
      calls(values).find((fact) => fact.callee === "@import")?.binding,
    ).toBe("unknown");
  });

  test("binds imported namespaces and cImport aliases", async () => {
    const values = calls(await facts("imports.zig"));
    for (const callee of ["std.debug.print", "local.execute", "c.printf"]) {
      expect(values.find((fact) => fact.callee === callee)?.binding).toBe(
        "import",
      );
    }
  });

  test("targets direct functions and binds parameters and locals", async () => {
    const functions = calls(await facts("functions.zig"));
    expect(
      functions.find((fact) => fact.callee === "helper")?.target,
    ).toMatchObject({ kind: "function", name: "helper" });
    expect(
      functions.find((fact) => fact.callee === "external")?.target,
    ).toMatchObject({ kind: "function", name: "external" });
    expect(functions.find((fact) => fact.callee === "loader")?.binding).toBe(
      "local",
    );
    expect(
      calls(await facts("scope.zig")).find((fact) => fact.callee === "callback")
        ?.binding,
    ).toBe("local");
  });

  test("owns calls inside declarations, methods, tests, and comptime blocks", async () => {
    expect(
      calls(await facts("functions.zig")).find(
        (fact) => fact.callee === "loader",
      )?.owner,
    ).toMatchObject({ kind: "constant", name: "value" });
    expect(
      calls(await facts("types.zig")).find((fact) => fact.callee === "render")
        ?.owner,
    ).toMatchObject({ kind: "method", name: "display" });
    expect(
      calls(await facts("tests.zig")).find((fact) => fact.callee === "register")
        ?.owner,
    ).toMatchObject({ kind: "initializer", name: "comptime" });
  });

  test("keeps Zig container declarations distinct", async () => {
    const path = join(FIXTURES, "types.zig");
    const result = await chunk(path, await Bun.file(path).text());
    expect(
      result.chunks
        .filter((chunk) => chunk.kind !== "gap")
        .map((chunk) => [chunk.kind, chunk.name]),
    ).toEqual([
      ["struct", "User"],
      ["enum", "State"],
      ["struct", "Value"],
      ["type", "Errors"],
    ]);
  });

  test("does not fabricate Zig export facts", async () => {
    expect(
      (await facts("functions.zig")).some((fact) => fact.kind === "export"),
    ).toBe(false);
  });

  test("ZIG-L1 scopes payload captures without leaking them", async () => {
    const values = calls(await facts("control-flow.zig"));
    const selected = values.filter((fact) =>
      ["callback", "other", "recovered"].includes(fact.callee)
    );
    expect(selected.map((fact) => [fact.callee, fact.startLine, fact.binding])).toEqual([
      ["callback", 15, "local"],
      ["callback", 17, "unknown"],
      ["callback", 20, "local"],
      ["callback", 24, "unknown"],
      ["callback", 28, "local"],
      ["callback", 31, "unknown"],
      ["callback", 35, "local"],
      ["callback", 37, "unknown"],
      ["callback", 40, "local"],
      ["other", 41, "local"],
      ["callback", 43, "unknown"],
      ["other", 44, "unknown"],
      ["recovered", 50, "local"],
    ]);
  });

  test("ZIG-L2 respects declaration timing, reassignment, and block boundaries", async () => {
    const values = calls(await facts("shadowing.zig"));
    const selected = values.filter((fact) =>
      ["target", "nested", "object", "values"].includes(fact.callee)
    );
    expect(selected.map((fact) => [fact.callee, fact.startLine, fact.binding])).toEqual([
      ["target", 7, "source-chunk"],
      ["target", 8, "local"],
      ["target", 11, "local"],
      ["nested", 15, "local"],
      ["nested", 17, "unknown"],
      ["object", 20, "unknown"],
      ["values", 22, "unknown"],
    ]);
    expect(selected[0]?.target).toMatchObject({
      kind: "function",
      name: "target",
      startLine: 4,
    });
  });

  test("ZIG-E1 preserves literal embedded resources without guessing dynamic paths", async () => {
    const values = await facts("resources.zig");
    expect(values.filter((fact): fact is ImportFact => fact.kind === "import")).toEqual([
      expect.objectContaining({
        source: "assets/message.txt",
        imported: "resource",
        local: "embedded",
      }),
    ]);
    expect(calls(values).find((fact) => fact.callee === "@embedFile")).toMatchObject({
      binding: "unknown",
      startLine: 2,
    });
  });

  test("ZIG-G1 pins the bundled grammar's destructuring recovery gap", async () => {
    const tree = await parse("const first, const second = tuple;\n", "zig");
    if (!tree) throw new Error("Zig parser returned no syntax tree");
    expect(tree.rootNode.hasError).toBe(true);
    expect(tree.rootNode.toString()).toContain("(ERROR)");
  });
});
