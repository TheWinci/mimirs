import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { chunk, type CallFact, type ImportFact } from "@winci/bun-chunk";

const FIXTURES = join(import.meta.dir, "fixtures", "java");

async function facts(fixture: string) {
  const path = join(FIXTURES, fixture);
  return (await chunk(path, await Bun.file(path).text())).facts;
}

function calls(values: Awaited<ReturnType<typeof facts>>): CallFact[] {
  return values.filter((fact): fact is CallFact => fact.kind === "call");
}

describe("Java source fact bindings", () => {
  test("preserves regular, wildcard, and static import forms", async () => {
    const values = await facts("imports.java");
    const imports = values.filter((fact): fact is ImportFact => fact.kind === "import");
    expect(imports.map((fact) => [
      fact.source,
      fact.imported,
      fact.local,
      fact.static,
    ])).toEqual([
      ["java.util.List", "*", "List", false],
      ["java.util", "*", null, false],
      ["java.util.Collections", "emptyList", "emptyList", true],
      ["java.util.Collections", "*", null, true],
    ]);
    expect(calls(values).map((fact) => [fact.callee, fact.binding])).toEqual([
      ["emptyList", "import"],
      ["singletonList", "unknown"],
      ["Set.of", "unknown"],
      ["List.of", "import"],
    ]);
  });

  test("keeps Java method and value namespaces distinct", async () => {
    const values = calls(await facts("scope.java"));
    expect(values.map((fact) => [fact.callee, fact.binding])).toEqual([
      ["run.run", "local"],
      ["callback.run", "local"],
      ["helper", "source-chunk"],
      ["Runner.start", "import"],
      ["run", "import"],
      ["Worker", "unknown"],
      ["build", "unknown"],
      ["Scope", "source-chunk"],
    ]);
    expect(values.find((fact) => fact.callee === "helper")?.target).toMatchObject({
      kind: "method",
      name: "helper",
    });
    expect(values.at(-1)?.target).toMatchObject({ kind: "class", name: "Scope" });
  });

  test("targets local lambdas and binds their parameters", async () => {
    const values = calls(await facts("fields.java"));
    expect(values.find((fact) => fact.callee === "value.trim")).toMatchObject({
      binding: "local",
      owner: { kind: "function", name: "normalize" },
    });
    expect(values.find((fact) => fact.callee === "normalize.apply")).toMatchObject({
      binding: "source-chunk",
      target: { kind: "function", name: "normalize" },
      owner: { kind: "method", name: "execute" },
    });
    expect(values.find((fact) => fact.callee === "initialize")?.owner).toMatchObject({
      kind: "class",
      name: "Configuration",
    });
  });

  test("avoids arbitrary targets for overloads while resolving unique methods", async () => {
    const values = calls(await facts("methods.java"));
    expect(values.map((fact) => [fact.callee, fact.binding])).toEqual([
      ["this", "local"],
      ["defaultValue", "source-chunk"],
      ["super", "local"],
      ["configure", "local"],
      ["mapper.apply", "local"],
      ["Processor.<String>create", "source-chunk"],
      ["create", "unknown"],
    ]);
    expect(values.find((fact) => fact.callee === "Processor.<String>create")?.target)
      .toMatchObject({ kind: "class", name: "Processor" });
  });

  test("binds implicit compact-constructor parameters", async () => {
    expect(calls(await facts("types.java")).find((fact) => fact.callee === "x.trim"))
      .toMatchObject({
        binding: "local",
        owner: { kind: "method", name: "Point" },
      });
  });

  test("does not fabricate export facts from Java visibility", async () => {
    expect((await facts("classes.java")).some((fact) => fact.kind === "export")).toBe(false);
  });

  test("JAVA-L1 scopes loops, resources, catches, and patterns without leaks", async () => {
    const values = calls(await facts("control-flow.java"));
    const selected = values.filter((fact) =>
      [
        "loop.run",
        "item.run",
        "resource.close",
        "error.printStackTrace",
        "callback.run",
        "first.run",
        "second.run",
        "selected.run",
        "repeated.run",
      ].includes(fact.callee)
    );
    expect(selected.map((fact) => [fact.callee, fact.startLine, fact.binding])).toEqual([
      ["loop.run", 28, "local"],
      ["loop.run", 30, "unknown"],
      ["item.run", 33, "local"],
      ["item.run", 35, "unknown"],
      ["resource.close", 38, "local"],
      ["resource.close", 40, "unknown"],
      ["error.printStackTrace", 45, "local"],
      ["error.printStackTrace", 47, "unknown"],
      ["callback.run", 50, "local"],
      ["callback.run", 52, "unknown"],
      ["first.run", 55, "local"],
      ["second.run", 56, "local"],
      ["first.run", 58, "unknown"],
      ["selected.run", 61, "local"],
      ["selected.run", 64, "unknown"],
      ["repeated.run", 67, "local"],
      ["repeated.run", 70, "unknown"],
    ]);
  });

  test("JAVA-L2 respects declaration order, grouped declarations, and block scope", async () => {
    const values = calls(await facts("shadowing.java"));
    const selected = values.filter((fact) =>
      [
        "target",
        "target.run",
        "first.run",
        "second.run",
        "nested.run",
        "object.run",
        "values.run",
      ].includes(fact.callee)
    );
    expect(selected.map((fact) => [fact.callee, fact.startLine, fact.binding])).toEqual([
      ["target", 17, "source-chunk"],
      ["target.run", 18, "local"],
      ["target.run", 21, "local"],
      ["first.run", 24, "local"],
      ["second.run", 25, "local"],
      ["nested.run", 29, "local"],
      ["nested.run", 31, "unknown"],
      ["object.run", 34, "unknown"],
      ["values.run", 36, "unknown"],
    ]);
    expect(selected[0]?.target).toMatchObject({
      kind: "method",
      name: "target",
      startLine: 12,
    });
  });

  test("JAVA-E1 preserves JPMS requires modifiers without inventing module exports", async () => {
    const values = await facts("module-info.java");
    expect(values.filter((fact): fact is ImportFact => fact.kind === "import").map((fact) => [
      fact.source,
      fact.imported,
      fact.typeOnly,
      fact.static,
      fact.global,
      fact.owner?.name ?? null,
    ])).toEqual([
      ["java.base", "module", false, false, false, "fixtures.app"],
      ["fixtures.api", "module", false, false, true, "fixtures.app"],
      ["optional.logging", "module", true, true, false, "fixtures.app"],
    ]);
    expect(values.some((fact) => fact.kind === "export")).toBe(false);
  });

  test("JAVA-E2 keeps references non-executable and owns anonymous-class calls", async () => {
    const values = calls(await facts("references.java"));
    expect(values.map((fact) => [
      fact.callee,
      fact.startLine,
      fact.binding,
      fact.owner?.name ?? null,
    ])).toEqual([
      ["Supplier<>", 9, "import", "anonymous"],
      ["create", 12, "unknown", "get"],
      ["consume", 18, "unknown", "execute"],
    ]);
    expect(await facts("package-info.java")).toEqual([]);
  });
});
