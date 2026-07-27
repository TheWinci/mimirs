import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { chunk, type CallFact, type ImportFact } from "@winci/bun-chunk";

const FIXTURES = join(import.meta.dir, "fixtures", "php");

async function facts(fixture: string) {
  const path = join(FIXTURES, fixture);
  return (await chunk(path, await Bun.file(path).text())).facts;
}

function calls(values: Awaited<ReturnType<typeof facts>>): CallFact[] {
  return values.filter((fact): fact is CallFact => fact.kind === "call");
}

describe("PHP source fact bindings", () => {
  test("preserves class, function, const, grouped, and aliased uses", async () => {
    const imports = (await facts("imports.php")).filter(
      (fact): fact is ImportFact => fact.kind === "import",
    );
    expect(
      imports
        .slice(0, 13)
        .map((fact) => [fact.source, fact.imported, fact.local]),
    ).toEqual([
      ["Vendor\\Package\\Client", "class", "Client"],
      ["Vendor\\Package\\Service", "class", "WorkerService"],
      ["Vendor\\Package\\Helper", "class", "Helper"],
      ["Vendor\\Package\\Formatter", "class", "TextFormatter"],
      ["Vendor\\helpers\\run", "function", "run"],
      ["Vendor\\helpers\\start", "function", "start"],
      ["Vendor\\helpers\\stop", "function", "halt"],
      ["Vendor\\VERSION", "const", "VERSION"],
      ["Vendor\\flags\\ENABLED", "const", "ENABLED"],
      ["Vendor\\flags\\DISABLED", "const", "OFF"],
      ["Vendor\\Mixed\\Thing", "class", "Thing"],
      ["Vendor\\Mixed\\execute", "function", "exec"],
      ["Vendor\\Mixed\\FLAG", "const", "FLAG"],
    ]);
  });

  test("keeps literal runtime imports separate from dynamic runtime calls", async () => {
    const values = await facts("imports.php");
    const runtime = values.filter(
      (fact): fact is ImportFact =>
        fact.kind === "import" &&
        ["require", "require_once", "include", "include_once"].includes(
          fact.imported ?? "",
        ),
    );
    expect(runtime.map((fact) => [fact.imported, fact.source])).toEqual([
      ["require", "bootstrap.php"],
      ["require_once", "config.php"],
      ["include", "helpers.php"],
      ["include_once", "optional.php"],
    ]);
    expect(calls(values).map((fact) => fact.callee)).toEqual([
      "require_once",
      "include",
    ]);
  });

  test("binds parameters, functions, member roots, and same-file classes", async () => {
    const values = calls(await facts("calls.php"));
    expect(values.find((fact) => fact.callee === "$loader")?.binding).toBe(
      "local",
    );
    expect(
      values.find((fact) => fact.callee === "helper")?.target,
    ).toMatchObject({ kind: "function", name: "helper" });
    expect(
      values.find((fact) => fact.callee === "$service?->maybe")?.binding,
    ).toBe("local");
    expect(
      values.find((fact) => fact.callee === "Worker")?.target,
    ).toMatchObject({ kind: "class", name: "Worker" });
  });

  test("targets named arrow and anonymous functions", async () => {
    const values = calls(await facts("functions.php"));
    expect(
      values.find((fact) => fact.callee === "$normalize")?.target,
    ).toMatchObject({ kind: "function", name: "normalize" });
    expect(values.find((fact) => fact.callee === "$map")?.target).toMatchObject(
      { kind: "function", name: "map" },
    );
    expect(values.find((fact) => fact.callee === "$loader")?.binding).toBe(
      "local",
    );
  });

  test("owns calls in constants and property hooks precisely", async () => {
    const values = calls(await facts("members.php"));
    expect(
      values.find((fact) => fact.callee === "load_first")?.owner,
    ).toMatchObject({ kind: "constant", name: "FIRST, SECOND" });
    expect(
      values.find((fact) => fact.callee === "save_title")?.owner,
    ).toMatchObject({ kind: "field", name: "title" });
  });

  test("binds namespace aliases without crossing namespace spans", async () => {
    expect(
      calls(await facts("namespaces.php")).map((fact) => [
        fact.callee,
        fact.binding,
        fact.owner?.name,
      ]),
    ).toEqual([
      ["Tool::run", "import", "first"],
      ["Tool::run", "import", "second"],
      ["Tool::run", "import", "third"],
      ["finish", "unknown", "fallback"],
    ]);
  });

  test("does not fabricate export facts from PHP visibility", async () => {
    expect(
      (await facts("types.php")).some((fact) => fact.kind === "export"),
    ).toBe(false);
  });

  test("PHP-L1 retains function-scoped loop, catch, destructuring, and declared globals", async () => {
    const values = calls(await facts("control-flow.php"));
    const binding = (line: number, callee: string) =>
      values.find((fact) => fact.startLine === line && fact.callee === callee)?.binding;
    expect([
      binding(5, "$key"),
      binding(6, "$callback"),
      binding(8, "$key"),
      binding(9, "$callback"),
      binding(12, "$left"),
      binding(15, "$left"),
      binding(19, "$index"),
      binding(21, "$index"),
      binding(26, "$failure"),
      binding(28, "$failure"),
      binding(48, "$first"),
      binding(49, "$second"),
      binding(52, "$globalCallback"),
      binding(54, "$staticCallback"),
    ]).toEqual(Array(14).fill("local"));
  });

  test("PHP-L2 respects nested assignment timing, reassignment, and unset", async () => {
    const values = calls(await facts("control-flow.php"));
    expect(values.filter((fact) => [32, 34, 36, 38, 41, 43, 45].includes(fact.startLine)).map(
      (fact) => [fact.startLine, fact.callee, fact.binding, fact.target?.name ?? null],
    )).toEqual([
      [32, "$conditional", "source-chunk", "conditional"],
      [34, "$conditional", "source-chunk", "conditional"],
      [36, "$before", "unknown", null],
      [38, "$before", "source-chunk", "before"],
      [41, "$callable", "source-chunk", "callable"],
      [43, "$callable", "local", null],
      [45, "$callable", "unknown", null],
    ]);
  });

  test("PHP-L3 distinguishes arrow capture from explicit and missing closure use", async () => {
    const values = calls(await facts("captures.php"));
    expect(values.filter((fact) => fact.callee === "$outer").map((fact) => [
      fact.startLine,
      fact.binding,
      fact.owner?.name,
    ])).toEqual([
      [4, "local", "arrow"],
      [7, "local", "explicit"],
      [11, "unknown", "missing"],
    ]);
  });

  test("PHP-E1 keeps first-class callable references non-executable", async () => {
    expect(calls(await facts("captures.php")).some(
      (fact) => [14, 15].includes(fact.startLine),
    )).toBe(false);
  });
});
