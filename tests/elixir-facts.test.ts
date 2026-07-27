import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { chunk, type CallFact, type ImportFact } from "@winci/bun-chunk";

const FIXTURES = join(import.meta.dir, "fixtures", "elixir");

async function facts(fixture: string) {
  const path = join(FIXTURES, fixture);
  return (await chunk(path, await Bun.file(path).text())).facts;
}

function calls(values: Awaited<ReturnType<typeof facts>>): CallFact[] {
  return values.filter((fact): fact is CallFact => fact.kind === "call");
}

function callAt(values: CallFact[], callee: string, line: number): CallFact {
  return values.find(
    (fact) => fact.callee === callee && fact.startLine === line,
  )!;
}

describe("Elixir source fact bindings", () => {
  test("preserves aliases, grouped aliases, imports, requires, and uses", async () => {
    const imports = (await facts("imports.ex")).filter(
      (fact): fact is ImportFact => fact.kind === "import",
    );
    expect(
      imports.map((fact) => [fact.source, fact.imported, fact.local]),
    ).toEqual([
      ["App.Worker", "alias", "Worker"],
      ["App.Worker", "alias", "Job"],
      ["App.Tasks.One", "alias", "One"],
      ["App.Tasks.Two", "alias", "Two"],
      ["Enum", "map/2", "map"],
      ["Logger", "require", "Logger"],
      ["GenServer", "use", null],
    ]);
  });

  test("binds aliases, selected imports, and required modules", async () => {
    const values = calls(await facts("imports.ex"));
    for (const callee of [
      "Worker.run",
      "Job.run",
      "One.run",
      "Two.run",
      "map",
      "Logger.info",
    ]) {
      expect(values.find((fact) => fact.callee === callee)?.binding).toBe(
        "import",
      );
    }
  });

  test("targets direct functions without choosing an overloaded clause", async () => {
    const definitions = calls(await facts("definitions.ex"));
    expect(
      definitions.find((fact) => fact.callee === "helper")?.target,
    ).toMatchObject({ kind: "function", name: "helper" });
    expect(definitions.some((fact) => fact.callee === "run")).toBe(false);

    expect(
      calls(await facts("calls.ex")).find((fact) => fact.callee === "local")
        ?.target,
    ).toMatchObject({ kind: "function", name: "local" });
  });

  test("binds function, anonymous-function, and remote receiver variables", async () => {
    const scope = calls(await facts("scope.ex"));
    expect(scope.find((fact) => fact.callee === "loader")?.binding).toBe(
      "local",
    );
    expect(
      scope.find((fact) => fact.callee === "callback")?.target,
    ).toMatchObject({ kind: "function", name: "callback" });
    expect(
      calls(await facts("calls.ex")).find(
        (fact) => fact.callee === "service.execute",
      )?.binding,
    ).toBe("local");
    expect(
      calls(await facts("protocols.ex")).find(
        (fact) => fact.callee === "user.name",
      )?.binding,
    ).toBe("local");
  });

  test("excludes definition heads and calls inside type attributes", async () => {
    const definitions = calls(await facts("definitions.ex"));
    expect(definitions.some((fact) => fact.callee === "run")).toBe(false);
    expect(definitions.some((fact) => fact.callee === "is_ready")).toBe(false);
    expect(
      calls(await facts("protocols.ex")).map((fact) => fact.callee),
    ).toEqual(["user.name"]);
  });

  test("does not fabricate Elixir export facts", async () => {
    expect(
      (await facts("definitions.ex")).some((fact) => fact.kind === "export"),
    ).toBe(false);
  });

  test("EX-L1 binds assignment, case, and receive patterns without leaking", async () => {
    const values = calls(await facts("control-flow.ex"));
    expect(callAt(values, "pair", 3).binding).toBe("unknown");
    expect(callAt(values, "left", 4).binding).toBe("local");
    expect(callAt(values, "right", 5).binding).toBe("local");
    expect(callAt(values, "value", 13).binding).toBe("local");
    expect(callAt(values, "value", 16).binding).toBe("unknown");
    expect(callAt(values, "payload", 40).binding).toBe("local");
    expect(callAt(values, "payload", 44).binding).toBe("unknown");
  });

  test("EX-L2 keeps with and comprehension binders ordered and local", async () => {
    const values = calls(await facts("control-flow.ex"));
    for (const [callee, insideLine, outsideLine] of [
      ["first", 21, 26],
      ["second", 22, 27],
      ["reason", 24, 28],
      ["item", 33, 36],
      ["prepared", 34, 37],
    ] as const) {
      expect(callAt(values, callee, insideLine).binding).toBe("local");
      expect(callAt(values, callee, outsideLine).binding).toBe("unknown");
    }
  });

  test("EX-L3 keeps named closure targets until direct rebinding and ignores captures", async () => {
    const values = calls(await facts("control-flow.ex"));
    expect(callAt(values, "helper", 7).binding).toBe("source-chunk");
    expect(callAt(values, "callback", 8).binding).toBe("source-chunk");
    expect(callAt(values, "callback", 10).binding).toBe("local");
    expect(values.filter((fact) => fact.callee === "helper")).toHaveLength(1);
  });

  test("EX-E1 retains only and except filters while binding selected imports only", async () => {
    const values = await facts("filters.ex");
    expect(
      values
        .filter((fact): fact is ImportFact => fact.kind === "import")
        .map((fact) => [fact.source, fact.imported, fact.local]),
    ).toEqual([
      ["Enum", "map/2", "map"],
      ["Enum", "filter/2", "filter"],
      ["List", "except flatten/1", null],
      ["List", "except first/1", null],
      ["String", "import", null],
    ]);
    const callValues = calls(values);
    expect(callAt(callValues, "map", 7).binding).toBe("import");
    expect(callAt(callValues, "filter", 8).binding).toBe("import");
    expect(callAt(callValues, "flatten", 9).binding).toBe("unknown");
    expect(callAt(callValues, "upcase", 10).binding).toBe("unknown");
  });

  test("EXS-L1 applies explicit script scope without host assumptions", async () => {
    const values = calls(await facts("script-scope.exs"));
    expect(callAt(values, "make", 2).binding).toBe("source-chunk");
    expect(callAt(values, "value", 5).binding).toBe("local");
    expect(callAt(values, "value", 7).binding).toBe("unknown");
    expect(callAt(values, "item", 10).binding).toBe("local");
    expect(callAt(values, "item", 12).binding).toBe("unknown");
    expect(values.some((fact) => fact.startLine === 14)).toBe(false);
  });
});
