import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  chunk,
  type CallFact,
  type ImportFact,
  type SourceFact,
} from "@winci/bun-chunk";

const FIXTURES = join(import.meta.dir, "fixtures", "ocaml");

async function result(fixture: string) {
  const path = join(FIXTURES, fixture);
  return chunk(path, await Bun.file(path).text());
}

function calls(values: SourceFact[]): CallFact[] {
  return values.filter((fact): fact is CallFact => fact.kind === "call");
}

function callAt(values: CallFact[], callee: string, line: number): CallFact {
  return values.find(
    (fact) => fact.callee === callee && fact.startLine === line,
  )!;
}

describe("OCaml source fact bindings", () => {
  test("preserves opens, includes, aliases, and local opens", async () => {
    const modules = (await result("modules.ml")).facts.filter(
      (fact): fact is ImportFact => fact.kind === "import",
    );
    expect(
      modules.map((fact) => [fact.source, fact.imported, fact.local]),
    ).toEqual([
      ["Core", "open", null],
      ["Utilities", "include", null],
      ["App.Service", "module", "Alias"],
    ]);
    expect(
      (await result("calls.ml")).facts.find(
        (fact): fact is ImportFact => fact.kind === "import",
      ),
    ).toMatchObject({
      source: "Core",
      imported: "open",
      owner: { name: "local" },
    });
  });

  test("binds module aliases without guessing ordinary module lookup", async () => {
    const values = calls((await result("modules.ml")).facts);
    expect(
      values.find((fact) => fact.callee === "Alias.execute")?.binding,
    ).toBe("import");
    expect(values.find((fact) => fact.callee === "Built.find")?.binding).toBe(
      "unknown",
    );
    expect(values.find((fact) => fact.callee === "Map.Make")?.binding).toBe(
      "unknown",
    );
  });

  test("targets every member of a mutually recursive binding group", async () => {
    const values = calls((await result("functions.ml")).facts);
    for (const callee of ["even", "odd"]) {
      expect(
        values.find((fact) => fact.callee === callee)?.target,
      ).toMatchObject({
        kind: "function",
        name: "even, odd",
      });
    }
  });

  test("respects sequential visibility and explicit recursive bindings", async () => {
    const values = calls((await result("visibility.ml")).facts);
    expect(values.find((fact) => fact.callee === "later")?.binding).toBe(
      "unknown",
    );
    expect(
      values.find((fact) => fact.callee === "recurse")?.target,
    ).toMatchObject({
      kind: "function",
      name: "recurse",
    });
    expect(values.filter((fact) => fact.callee === "local")).toHaveLength(2);
    expect(
      values
        .filter((fact) => fact.callee === "local")
        .every((fact) => fact.target?.name === "local"),
    ).toBe(true);
  });

  test("targets external declarations and preserves infix applications", async () => {
    const values = calls((await result("functions.ml")).facts);
    expect(
      values.find((fact) => fact.callee === "clock")?.target,
    ).toMatchObject({
      kind: "function",
      name: "clock",
    });
    expect(
      values.filter((fact) =>
        ["=", "||", "-", "<>", "&&"].includes(fact.callee),
      ),
    ).toHaveLength(6);
  });

  test("binds parameters and nested functions with precise ownership", async () => {
    const values = calls((await result("scope.ml")).facts);
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

  test("keeps values, destructuring, and function-valued bindings distinct", async () => {
    const value = await result("bindings.ml");
    expect(value.chunks.map((chunk) => [chunk.name, chunk.kind])).toEqual([
      ["name", "variable"],
      ["left, right", "variable"],
      ["callback", "function"],
      [null, "gap"],
      ["result", "variable"],
    ]);
    expect(
      calls(value.facts).find((fact) => fact.callee === "callback")?.target,
    ).toMatchObject({ kind: "function", name: "callback" });
  });

  test("binds object receivers locally and same-file class construction exactly", async () => {
    const values = calls((await result("classes.ml")).facts);
    expect(values.find((fact) => fact.callee === "service#run")?.binding).toBe(
      "local",
    );
    expect(
      values.find((fact) => fact.callee === "worker")?.target,
    ).toMatchObject({
      kind: "class",
      name: "worker",
    });
  });

  test("targets variant constructors from their explicit local type declarations", async () => {
    const values = calls((await result("types.ml")).facts);
    expect(values.map((fact) => fact.callee)).toEqual(["Ok", "Error"]);
    expect(values.map((fact) => fact.target?.name)).toEqual([
      "result",
      "result",
    ]);
  });

  test("does not treat local opens as proof that a called name exists", async () => {
    expect(
      calls((await result("calls.ml")).facts).find(
        (fact) => fact.callee === "compute",
      )?.binding,
    ).toBe("unknown");
  });

  test("does not fabricate OCaml export facts", async () => {
    expect(
      (await result("types.ml")).facts.some((fact) => fact.kind === "export"),
    ).toBe(false);
  });

  test("routes interfaces through declaration-only OCaml grammar", async () => {
    const value = await result("interface.mli");
    expect(value).toMatchObject({ language: "ocaml", strategy: "ast" });
    expect(
      value.chunks
        .filter((chunk) => chunk.kind !== "gap")
        .map((chunk) => [chunk.kind, chunk.name]),
    ).toEqual([
      ["comment", null],
      ["type", "id"],
      ["type", "result"],
      ["type", "Unavailable"],
      ["function", "create"],
      ["function", "run"],
      ["function", "clock"],
      ["type", "SERVICE"],
      ["module", "Service"],
      ["interface", "worker"],
    ]);
    expect(value.facts).toEqual([]);
  });

  test("keeps interface dependencies without inventing calls", async () => {
    const facts = (await result("interface-modules.mli")).facts;
    expect(
      facts
        .filter((fact): fact is ImportFact => fact.kind === "import")
        .map((fact) => [fact.source, fact.imported, fact.local]),
    ).toEqual([
      ["Core", "open", null],
      ["Base", "include", null],
      ["Existing", "module", "Alias"],
    ]);
    expect(calls(facts)).toEqual([]);
  });

  test("OCAML-L1 scopes match, function, exception, and tuple patterns", async () => {
    const values = calls((await result("patterns.ml")).facts);
    expect(callAt(values, "callback", 4).binding).toBe("local");
    expect(callAt(values, "callback", 7).binding).toBe("unknown");
    expect(callAt(values, "left", 11).binding).toBe("local");
    expect(callAt(values, "callback", 15).binding).toBe("local");
    expect(callAt(values, "callback", 22).binding).toBe("local");
  });

  test("OCAML-E1 keeps nested module aliases lexical and non-leaking", async () => {
    const value = await result("module-shadowing.ml");
    expect(
      value.facts
        .filter((fact): fact is ImportFact => fact.kind === "import")
        .map((fact) => [fact.source, fact.local, fact.owner?.name]),
    ).toEqual([
      ["External", "Alias", undefined],
      ["Internal", "Alias", "local"],
    ]);
    const values = calls(value.facts);
    expect(callAt(values, "Alias.execute", 5).binding).toBe("import");
    expect(callAt(values, "Alias.execute", 7).binding).toBe("import");
  });
});
