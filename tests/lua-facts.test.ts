import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { chunk, type CallFact, type ImportFact } from "@winci/bun-chunk";

const FIXTURES = join(import.meta.dir, "fixtures", "lua");

async function facts(fixture: string) {
  const path = join(FIXTURES, fixture);
  return (await chunk(path, await Bun.file(path).text())).facts;
}

function calls(values: Awaited<ReturnType<typeof facts>>): CallFact[] {
  return values.filter((fact): fact is CallFact => fact.kind === "call");
}

describe("Lua source fact bindings", () => {
  test("extracts only literal require calls as imports", async () => {
    const values = await facts("modules.lua");
    expect(
      values
        .filter((fact): fact is ImportFact => fact.kind === "import")
        .map((fact) => [fact.source, fact.local]),
    ).toEqual([
      ["json", "json"],
      ["app.util", "util"],
      ["setup", null],
    ]);
    expect(
      calls(values).find((fact) => fact.callee === "require")?.binding,
    ).toBe("unknown");
  });

  test("binds required module aliases without guessing dynamic modules", async () => {
    const values = calls(await facts("modules.lua"));
    expect(values.find((fact) => fact.callee === "json.decode")?.binding).toBe(
      "import",
    );
    expect(values.find((fact) => fact.callee === "util.prepare")?.binding).toBe(
      "import",
    );
  });

  test("targets local, dotted, and colon-declared functions", async () => {
    const values = calls(await facts("functions.lua"));
    expect(
      values.find((fact) => fact.callee === "helper")?.target,
    ).toMatchObject({ kind: "function", name: "helper" });
    expect(values.find((fact) => fact.callee === "run")?.target).toMatchObject({
      kind: "function",
      name: "run",
    });
    expect(
      values.find((fact) => fact.callee === "M.build")?.target,
    ).toMatchObject({ kind: "function", name: "M.build" });
    expect(
      values.find((fact) => fact.callee === "M:execute")?.target,
    ).toMatchObject({ kind: "method", name: "M:execute" });
  });

  test("binds parameters, implicit self, and named closures", async () => {
    const functions = calls(await facts("functions.lua"));
    expect(functions.find((fact) => fact.callee === "loader")?.binding).toBe(
      "local",
    );
    expect(
      functions.find((fact) => fact.callee === "self.client:send")?.binding,
    ).toBe("local");

    const scope = calls(await facts("scope.lua"));
    expect(
      scope.find((fact) => fact.callee === "callback")?.target,
    ).toMatchObject({ kind: "function", name: "callback" });
    expect(
      scope.find((fact) => fact.callee === "local_callback")?.target,
    ).toMatchObject({ kind: "function", name: "local_callback" });
  });

  test("keeps tables as variables and function-valued fields as functions", async () => {
    const path = join(FIXTURES, "tables.lua");
    const result = await chunk(path, await Bun.file(path).text());
    expect(result.chunks[0]).toMatchObject({ kind: "variable", name: "M" });
    expect(result.chunks[0]?.children).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "function", name: "run" }),
        expect.objectContaining({ kind: "function", name: "named" }),
      ]),
    );
  });

  test("preserves method, dotted, chained, string, and table call spelling", async () => {
    expect(calls(await facts("calls.lua")).map((fact) => fact.callee)).toEqual([
      "make",
      "build",
      "run",
      "service:execute",
      "module.helper",
      "build",
      "build()",
      "consume",
      "load",
      "print",
    ]);
  });

  test("does not fabricate Lua export facts", async () => {
    expect(
      (await facts("functions.lua")).some((fact) => fact.kind === "export"),
    ).toBe(false);
  });

  test("LUA-L1 scopes numeric, generic, and repeat-loop bindings", async () => {
    const values = calls(await facts("control-flow.lua"));
    const binding = (line: number, callee: string) =>
      values.find((fact) => fact.startLine === line && fact.callee === callee)?.binding;
    expect([
      binding(5, "index"),
      binding(9, "scoped"),
      binding(15, "key"),
      binding(16, "value"),
      binding(25, "repeated"),
      binding(26, "repeated"),
    ]).toEqual([
      "local",
      "source-chunk",
      "local",
      "local",
      "source-chunk",
      "source-chunk",
    ]);
    expect([
      binding(11, "index"),
      binding(12, "scoped"),
      binding(18, "key"),
      binding(19, "value"),
      binding(27, "repeated"),
    ]).toEqual(Array(5).fill("unknown"));
  });

  test("LUA-L2 respects declaration timing, reassignment, and parallel locals", async () => {
    const values = calls(await facts("control-flow.lua"));
    expect(values.filter((fact) => [29, 33, 38, 40, 43, 44].includes(fact.startLine)).map(
      (fact) => [fact.startLine, fact.callee, fact.binding, fact.target?.name ?? null],
    )).toEqual([
      [29, "before", "unknown", null],
      [33, "before", "source-chunk", "before"],
      [38, "callback", "source-chunk", "callback"],
      [40, "callback", "local", null],
      [43, "first", "local", null],
      [44, "second", "local", null],
    ]);
  });

  test("LUA-E1 preserves literal loaders and rejects shadowed loader semantics", async () => {
    const values = await facts("loaders.lua");
    expect(values.filter((fact): fact is ImportFact => fact.kind === "import").map(
      (fact) => [fact.source, fact.imported, fact.local],
    )).toEqual([
      ["real", "*", "real"],
      ["scripts/setup.lua", "dofile", null],
      ["scripts/task.lua", "loadfile", "compiled"],
      ["after-block", "*", null],
    ]);
    expect(calls(values).filter((fact) => ["require", "dofile"].includes(fact.callee)).map(
      (fact) => [fact.startLine, fact.callee, fact.binding],
    )).toEqual([
      [6, "require", "local"],
      [7, "dofile", "local"],
      [14, "require", "source-chunk"],
      [20, "require", "local"],
    ]);
  });
});
