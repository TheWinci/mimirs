import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { chunk, type CallFact, type ImportFact } from "@winci/bun-chunk";

const FIXTURES = join(import.meta.dir, "fixtures", "go");

async function facts(fixture: string) {
  const path = join(FIXTURES, fixture);
  return (await chunk(path, await Bun.file(path).text())).facts;
}

function calls(values: Awaited<ReturnType<typeof facts>>): CallFact[] {
  return values.filter((fact): fact is CallFact => fact.kind === "call");
}

describe("Go source fact bindings", () => {
  test("resolves parameters and local closures", async () => {
    const values = calls(await facts("functions.go"));
    expect(values.map((fact) => [fact.callee, fact.binding])).toEqual([
      ["FormatName", "unknown"],
      ["loader", "local"],
      ["Clean", "unknown"],
      ["normalize", "source-chunk"],
    ]);
    expect(values.at(-1)?.target).toMatchObject({ kind: "function", name: "normalize" });
  });

  test("does not guess default or dot-import package bindings", async () => {
    const values = await facts("imports.go");
    const imports = values.filter((fact): fact is ImportFact => fact.kind === "import");
    expect(imports.map((fact) => [fact.source, fact.imported, fact.local])).toEqual([
      ["fmt", "*", null],
      ["example.com/project/tool", "*", "tool"],
      ["strings", "*", null],
      ["math", "*", "."],
      ["example.com/project/driver", null, "_"],
    ]);

    const bindings = calls(values).map((fact) => [fact.callee, fact.binding]);
    expect(bindings).toEqual([
      ["fmt.Println", "unknown"],
      ["strings.TrimSpace", "unknown"],
      ["tool.Run", "import"],
      ["Println", "unknown"],
      ["Sqrt", "unknown"],
    ]);
  });

  test("resolves receiver and package-level function bindings", async () => {
    const methodCalls = calls(await facts("methods.go"));
    expect(methodCalls.map((fact) => [fact.callee, fact.binding])).toEqual([
      ["loader", "local"],
      ["cache.normalize", "local"],
    ]);

    const scopeCalls = calls(await facts("scope.go"));
    expect(scopeCalls.map((fact) => [fact.callee, fact.binding])).toEqual([
      ["run", "local"],
      ["runner.Run", "import"],
      ["helper", "source-chunk"],
    ]);
    expect(scopeCalls.at(-1)?.target).toMatchObject({ kind: "function", name: "helper" });
  });

  test("targets named types used as conversions", async () => {
    const values = calls(await facts("types.go"));
    expect(values[0]).toMatchObject({
      callee: "NewStore",
      binding: "unknown",
      owner: { kind: "variable", name: "ActiveStore" },
    });
    expect(values[1]).toMatchObject({
      callee: "Identifier",
      binding: "source-chunk",
      target: { kind: "type", name: "Identifier" },
    });
  });

  test("resolves instantiated generic functions", async () => {
    const [identity] = calls(await facts("generics.go"));
    expect(identity).toMatchObject({
      callee: "Identity[string]",
      binding: "source-chunk",
      target: { kind: "function", name: "Identity" },
    });
  });

  test("keeps grouped declaration ownership precise", async () => {
    const [buildStore] = calls(await facts("declarations.go"));
    expect(buildStore).toMatchObject({
      callee: "BuildStore",
      owner: { kind: "variable", name: "PrimaryStore" },
    });
  });

  test("GO-L1 scopes control-flow bindings without leaking them", async () => {
    const values = calls(await facts("control-flow.go"));
    expect(
      values.map((fact) => [fact.callee, fact.startLine, fact.binding]),
    ).toEqual([
      ["source", 10, "local"],
      ["condition", 10, "local"],
      ["source", 11, "local"],
      ["branch", 12, "local"],
      ["selected", 13, "local"],
      ["selected", 15, "local"],
      ["selected", 17, "unknown"],
      ["source", 19, "local"],
      ["condition", 19, "local"],
      ["source", 19, "local"],
      ["loop", 20, "local"],
      ["loop", 22, "unknown"],
      ["item", 25, "local"],
      ["item", 27, "unknown"],
      ["reused", 31, "local"],
      ["source", 34, "local"],
      ["condition", 34, "local"],
      ["choice", 36, "local"],
      ["source", 39, "local"],
      ["initial", 41, "local"],
      ["current", 42, "local"],
      ["initial", 44, "local"],
      ["current", 45, "local"],
      ["initial", 47, "unknown"],
      ["current", 48, "unknown"],
      ["received", 52, "local"],
      ["source", 53, "local"],
      ["sent", 54, "unknown"],
      ["received", 56, "unknown"],
    ]);
  });

  test("GO-L2 respects declaration timing, rebinding, and block boundaries", async () => {
    const values = calls(await facts("shadowing.go"));
    const targetCalls = values.filter((fact) => fact.callee === "target");
    expect(
      targetCalls.map((fact) => [fact.startLine, fact.binding, fact.target?.startLine ?? null]),
    ).toEqual([
      [7, "source-chunk", 3],
      [9, "source-chunk", 6],
      [12, "local", null],
      [15, "local", null],
    ]);
    expect(
      values.filter((fact) => ["first", "second", "extra"].includes(fact.callee))
        .map((fact) => [fact.callee, fact.binding]),
    ).toEqual([
      ["extra", "local"],
      ["first", "local"],
      ["second", "local"],
    ]);
    expect(
      values.filter((fact) => ["nested", "object", "values"].includes(fact.callee))
        .map((fact) => [fact.callee, fact.startLine, fact.binding]),
    ).toEqual([
      ["nested", 24, "local"],
      ["nested", 26, "unknown"],
      ["object", 29, "unknown"],
      ["values", 31, "unknown"],
    ]);
  });

  test("GO-L3 binds function, receiver, and local type names", async () => {
    const values = calls(await facts("generic-bindings.go"));
    expect(
      values.map((fact) => [fact.callee, fact.startLine, fact.binding]),
    ).toEqual([
      ["factory", 7, "local"],
      ["finish", 8, "local"],
      ["T", 9, "local"],
      ["F", 10, "local"],
      ["T", 11, "local"],
      ["T", 19, "local"],
      ["string", 24, "unknown"],
      ["Converter", 24, "source-chunk"],
    ]);
    expect(values.at(-1)?.target).toMatchObject({
      kind: "type",
      name: "Converter",
    });
  });

  test("GO-E1 targets explicit method expressions without inferring method calls", async () => {
    const values = calls(await facts("method-expressions.go"));
    expect(
      values.map((fact) => [
        fact.callee,
        fact.binding,
        fact.target?.kind ?? null,
        fact.target?.name ?? null,
      ]),
    ).toEqual([
      ["Handler.Run", "source-chunk", "method", "Run"],
      ["(*Handler).Stop", "source-chunk", "method", "Stop"],
      ["handler.Run", "local", null, null],
      ["pointer.Stop", "local", null, null],
      ["missing", "local", null, null],
    ]);
  });
});
