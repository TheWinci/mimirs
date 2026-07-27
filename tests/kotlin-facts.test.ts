import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { chunk, parse, type CallFact, type ImportFact } from "@winci/bun-chunk";

const FIXTURES = join(import.meta.dir, "fixtures", "kotlin");

async function facts(fixture: string) {
  const path = join(FIXTURES, fixture);
  return (await chunk(path, await Bun.file(path).text())).facts;
}

function calls(values: Awaited<ReturnType<typeof facts>>): CallFact[] {
  return values.filter((fact): fact is CallFact => fact.kind === "call");
}

describe("Kotlin source fact bindings", () => {
  test("preserves direct, aliased, and wildcard imports", async () => {
    const imports = (await facts("imports.kt")).filter(
      (fact): fact is ImportFact => fact.kind === "import",
    );
    expect(
      imports.map((fact) => [fact.source, fact.imported, fact.local]),
    ).toEqual([
      ["kotlin.collections", "List", "List"],
      ["vendor", "Worker", "ImportedWorker"],
      ["vendor.tools", "*", null],
    ]);
    const values = calls(await facts("imports.kt"));
    expect(values.find((fact) => fact.callee === "List")?.binding).toBe(
      "import",
    );
    expect(
      values.find((fact) => fact.callee === "unknownWildcard")?.binding,
    ).toBe("unknown");
  });

  test("targets same-file functions, types, and named lambdas", async () => {
    const values = calls(await facts("scope.kt"));
    expect(
      values.find((fact) => fact.callee === "Worker")?.target,
    ).toMatchObject({ kind: "class", name: "Worker" });
    expect(
      values.find((fact) => fact.callee === "callback")?.target,
    ).toMatchObject({ kind: "function", name: "callback" });
    expect(
      values.find((fact) => fact.callee === "local")?.target,
    ).toMatchObject({ kind: "function", name: "local" });
    expect(
      values.find((fact) => fact.callee === "ImportedWorker.create")?.binding,
    ).toBe("import");
  });

  test("binds function, lambda, and constructor parameters locally", async () => {
    const functionCalls = calls(await facts("functions.kt"));
    for (const callee of [
      "mapper",
      "loader",
      "items.map",
      "item.normalized",
      "service?.refresh",
      "value.trim",
    ]) {
      expect(
        functionCalls.find((fact) => fact.callee === callee)?.binding,
      ).toBe("local");
    }
    expect(
      calls(await facts("types.kt")).find(
        (fact) => fact.callee === "client.execute",
      )?.binding,
    ).toBe("local");
    expect(
      calls(await facts("types.kt")).find(
        (fact) => fact.callee === "value.trim",
      )?.binding,
    ).toBe("local");
  });

  test("owns calls inside methods, fields, constructors, and companions", async () => {
    const values = calls(await facts("types.kt"));
    expect(
      values.find((fact) => fact.callee === "loadTitle")?.owner,
    ).toMatchObject({ kind: "field", name: "title" });
    expect(
      values.find((fact) => fact.callee === "initialize")?.owner,
    ).toMatchObject({ kind: "method", name: "constructor" });
    expect(
      values.find((fact) => fact.callee === "Service" && fact.startLine === 31)
        ?.owner,
    ).toMatchObject({ kind: "method", name: "default" });
  });

  test("does not double-count trailing lambdas or treat annotations as calls", async () => {
    const functionCalls = calls(await facts("functions.kt"));
    expect(
      functionCalls.filter((fact) => fact.callee === "transform<String>"),
    ).toHaveLength(1);
    expect(
      functionCalls.some((fact) => fact.callee.includes('("value")')),
    ).toBe(false);
    expect(
      calls(await facts("comments.kt")).some(
        (fact) => fact.callee === "Deprecated",
      ),
    ).toBe(false);
  });

  test("does not fabricate Kotlin export facts", async () => {
    expect(
      (await facts("types.kt")).some((fact) => fact.kind === "export"),
    ).toBe(false);
  });

  test("KT-L1 scopes loops, catches, destructuring, when subjects, and anonymous parameters", async () => {
    const values = calls(await facts("control-flow.kt"));
    const selected = values.filter((fact) =>
      [
        "item",
        "left",
        "right",
        "error.report",
        "first",
        "second",
        "selected",
        "parameter",
      ].includes(fact.callee)
    );
    expect(selected.map((fact) => [fact.callee, fact.startLine, fact.binding])).toEqual([
      ["item", 19, "local"],
      ["item", 21, "unknown"],
      ["left", 24, "local"],
      ["right", 25, "local"],
      ["left", 27, "unknown"],
      ["error.report", 32, "local"],
      ["error.report", 34, "unknown"],
      ["first", 37, "local"],
      ["second", 38, "local"],
      ["selected", 41, "local"],
      ["selected", 43, "unknown"],
      ["parameter", 46, "local"],
    ]);
  });

  test("KT-L2 respects initializer timing, reassignment, nested scope, and write negatives", async () => {
    const values = calls(await facts("shadowing.kt"));
    const selected = values.filter((fact) =>
      ["Target", "target", "nested", "receiver", "values"].includes(fact.callee)
    );
    expect(selected.map((fact) => [fact.callee, fact.startLine, fact.binding])).toEqual([
      ["Target", 9, "source-chunk"],
      ["target", 10, "local"],
      ["target", 13, "local"],
      ["nested", 17, "local"],
      ["nested", 19, "unknown"],
      ["receiver", 22, "unknown"],
      ["values", 24, "unknown"],
    ]);
    expect(selected[0]?.target).toMatchObject({ kind: "function", name: "Target" });
  });

  test("KTS-L1 applies explicit lexical scope without assuming a script host", async () => {
    expect(calls(await facts("script-scope.kts")).map((fact) => [
      fact.callee,
      fact.startLine,
      fact.binding,
    ])).toEqual([
      ["make", 5, "source-chunk"],
      ["callback", 6, "local"],
      ["make", 9, "source-chunk"],
      ["nested", 10, "local"],
      ["scoped", 12, "source-chunk"],
      ["nested", 13, "unknown"],
    ]);
  });

  test("KT-E1 keeps callable references non-executable", async () => {
    expect(calls(await facts("shadowing.kt")).some((fact) => fact.startLine === 26)).toBe(false);
    expect(calls(await facts("script-scope.kts")).some((fact) => fact.startLine === 15)).toBe(false);
  });

  test("KT-G1 pins modern syntax that the bundled grammar does not represent", async () => {
    const companion = await parse(
      "class Service { companion object { fun create() = Service() } }",
      "kotlin",
    );
    const contextReceiver = await parse(
      "context(Logger) fun run() { log() }",
      "kotlin",
    );
    if (!companion || !contextReceiver) throw new Error("Kotlin parser returned no syntax tree");
    expect(companion.rootNode.hasError).toBe(true);
    expect(contextReceiver.rootNode.namedChildren[0]?.type).toBe("infix_expression");
  });
});
