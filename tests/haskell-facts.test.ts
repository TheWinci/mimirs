import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  chunk,
  type CallFact,
  type ImportFact,
  type SourceFact,
} from "@winci/bun-chunk";

const FIXTURES = join(import.meta.dir, "fixtures", "haskell");

async function facts(fixture: string): Promise<SourceFact[]> {
  const path = join(FIXTURES, fixture);
  return (await chunk(path, await Bun.file(path).text())).facts;
}

function calls(values: SourceFact[]): CallFact[] {
  return values.filter((fact): fact is CallFact => fact.kind === "call");
}

function callAt(values: CallFact[], callee: string, line: number): CallFact {
  return values.find(
    (fact) => fact.callee === callee && fact.startLine === line,
  )!;
}

describe("Haskell source fact bindings", () => {
  test("preserves qualified, explicit, hiding, and open imports", async () => {
    const imports = (await facts("imports.hs")).filter(
      (fact): fact is ImportFact => fact.kind === "import",
    );
    expect(
      imports.map((fact) => [fact.source, fact.imported, fact.local]),
    ).toEqual([
      ["Data.Map", "*", "Map"],
      ["Data.Text", "Text", "Text"],
      ["Data.Text", "pack", "pack"],
      ["Data.List", "hiding sort", null],
      ["Control.Monad", "*", null],
    ]);
  });

  test("binds qualified aliases and explicit imported functions", async () => {
    const values = calls(await facts("imports.hs"));
    expect(values.find((fact) => fact.callee === "Map.lookup")?.binding).toBe(
      "import",
    );
    expect(values.find((fact) => fact.callee === "pack")?.binding).toBe(
      "import",
    );
  });

  test("records only the outer call for curried application", async () => {
    const values = calls(await facts("functions.hs"));
    expect(values.filter((fact) => fact.callee === "multiply")).toHaveLength(1);
  });

  test("targets recursion and keeps infix operators as calls", async () => {
    const values = calls(await facts("functions.hs"));
    expect(
      values.find((fact) => fact.callee === "factorial")?.target,
    ).toMatchObject({
      kind: "function",
      name: "factorial",
    });
    expect(
      values.filter((fact) => [">", "*", "-"].includes(fact.callee)),
    ).toHaveLength(3);
  });

  test("binds parameters and recursive let functions with exact ownership", async () => {
    const values = calls(await facts("scope.hs"));
    expect(values.find((fact) => fact.callee === "loader")).toMatchObject({
      binding: "local",
      owner: { kind: "function", name: "callback" },
    });
    expect(
      values.find((fact) => fact.callee === "callback")?.target,
    ).toMatchObject({
      kind: "function",
      name: "callback",
    });
  });

  test("does not choose one equation as the target of a multi-equation function", async () => {
    const values = calls(await facts("equations.hs")).filter(
      (fact) => fact.callee === "describe",
    );
    expect(values).toHaveLength(2);
    expect(
      values.every(
        (fact) => fact.binding === "unknown" && fact.target === null,
      ),
    ).toBe(true);
    expect(
      calls(await facts("equations.hs")).some((fact) => fact.callee === ":"),
    ).toBe(false);
  });

  test("targets functions declared in recursive where bindings", async () => {
    expect(
      calls(await facts("where.hs")).find((fact) => fact.callee === "output")
        ?.target,
    ).toMatchObject({ kind: "function", name: "output" });
  });

  test("targets constructors from their explicit local type declarations", async () => {
    const values = calls(await facts("types.hs"));
    expect(
      values.find((fact) => fact.callee === "UserId")?.target,
    ).toMatchObject({
      kind: "type",
      name: "UserId",
    });
    expect(values.find((fact) => fact.callee === "Ok")?.target).toMatchObject({
      kind: "type",
      name: "Result",
    });
  });

  test("does not choose a typeclass implementation for an unqualified call", async () => {
    expect(
      calls(await facts("comments.hs")).find((fact) => fact.callee === "render")
        ?.binding,
    ).toBe("unknown");
  });

  test("does not fabricate export facts from Haskell declarations", async () => {
    expect(
      (await facts("imports.hs")).some((fact) => fact.kind === "export"),
    ).toBe(false);
  });

  test("HS-L1 scopes case, let, do, and comprehension patterns without leaks", async () => {
    const values = calls(await facts("patterns.hs"));
    expect(callAt(values, "callback", 3).binding).toBe("local");
    expect(callAt(values, "callback", 5).binding).toBe("unknown");
    expect(callAt(values, "left", 9).binding).toBe("local");
    expect(callAt(values, "action", 13).binding).toBe("local");
    expect(callAt(values, "action", 16).binding).toBe("local");
    expect(values.some((fact) => fact.callee === "Just")).toBe(false);
  });

  test("HS-E1 retains nested import members, operators, and hiding names", async () => {
    const values = await facts("import-details.hs");
    expect(
      values
        .filter((fact): fact is ImportFact => fact.kind === "import")
        .map((fact) => [fact.source, fact.imported, fact.local]),
    ).toEqual([
      ["App.Types", "Result", "Result"],
      ["App.Types", "Ok", "Ok"],
      ["App.Types", "Err", "Err"],
      ["App.Types", "User", "User"],
      ["App.Types", "name", "name"],
      ["App.Types", "transform", "transform"],
      ["App.Types", "+", "+"],
      ["App.Hidden", "hiding ignored", null],
      ["App.Hidden", "hiding skipped", null],
      ["App.Qualified", "*", "Q"],
      ["App.Qualified", "qualified execute", null],
      ["App.Qualified", "qualified Item", null],
    ]);
    const callValues = calls(values);
    for (const [callee, line] of [
      ["transform", 7],
      ["Ok", 7],
      ["name", 8],
      ["+", 9],
      ["Q.execute", 10],
    ] as const) {
      expect(callAt(callValues, callee, line).binding).toBe("import");
    }
  });

  test("HS-E2 targets local constructors and generated field selectors", async () => {
    const values = calls(await facts("declarations.hs"));
    for (const [callee, type] of [
      ["Ok", "Result"],
      ["Err", "Result"],
      ["User", "User"],
      ["name", "User"],
    ] as const) {
      expect(values.find((fact) => fact.callee === callee)?.target).toMatchObject(
        { kind: "type", name: type },
      );
    }
  });

  test("HS-L2 lets local declarations shadow imports without choosing equations", async () => {
    const values = calls(await facts("shadowing.hs"));
    expect(callAt(values, "transform", 5).target).toMatchObject({
      kind: "function",
      name: "transform",
    });
    expect(callAt(values, "describe", 8)).toMatchObject({
      binding: "unknown",
      target: null,
    });
  });
});
