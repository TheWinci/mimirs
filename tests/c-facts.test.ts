import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { chunk, type CallFact, type ImportFact } from "@winci/bun-chunk";

const FIXTURES = join(import.meta.dir, "fixtures", "c");

async function facts(fixture: string) {
  const path = join(FIXTURES, fixture);
  return (await chunk(path, await Bun.file(path).text())).facts;
}

function calls(values: Awaited<ReturnType<typeof facts>>): CallFact[] {
  return values.filter((fact): fact is CallFact => fact.kind === "call");
}

describe("C source fact bindings", () => {
  test("preserves system, local, and conditional include spelling", async () => {
    const imports = (await facts("includes.c"))
      .filter((fact): fact is ImportFact => fact.kind === "import");
    expect(imports.map((fact) => [fact.source, fact.owner?.name ?? null])).toEqual([
      ["<stdio.h>", null],
      ["\"local.h\"", null],
      ["\"feature.h\"", "defined(FEATURE)"],
      ["DEBUG_HEADER", "defined(DEBUG) && LEVEL > 1"],
      ["\"fallback.h\"", "FALLBACK"],
      ["\"release.h\"", "else"],
    ]);
  });

  test("targets visible prototypes and function definitions", async () => {
    const values = calls(await facts("functions.c"));
    expect(values.map((fact) => [fact.callee, fact.binding])).toEqual([
      ["lookup", "unknown"],
      ["declared", "source-chunk"],
      ["helper", "source-chunk"],
    ]);
    expect(values.find((fact) => fact.callee === "declared")?.target).toMatchObject({
      kind: "function",
      name: "declared",
      startLine: 1,
    });
    expect(values.find((fact) => fact.callee === "helper")?.target).toMatchObject({
      kind: "function",
      name: "helper",
      startLine: 3,
    });
  });

  test("binds parameters, local pointers, global pointers, and member roots", async () => {
    const values = calls(await facts("scope.c"));
    expect(values.map((fact) => [fact.callee, fact.binding])).toEqual([
      ["helper", "source-chunk"],
      ["ops->run", "local"],
      ["loader", "local"],
      ["(*loader)", "local"],
      ["callback", "local"],
      ["make", "unknown"],
      ["make()->start", "unknown"],
      ["factory", "unknown"],
      ["global_callback", "local"],
    ]);
  });

  test("targets function-like and object-like macros without expansion", async () => {
    const values = calls(await facts("macros.c"));
    expect(values.map((fact) => [fact.callee, fact.binding])).toEqual([
      ["MAX", "source-chunk"],
      ["CALLBACK", "source-chunk"],
      ["TEMPORARY", "unknown"],
    ]);
    expect(values.map((fact) => fact.target?.kind ?? null)).toEqual([
      "macro",
      "macro",
      null,
    ]);
  });

  test("keeps initializer ownership and function-pointer calls precise", async () => {
    const values = calls(await facts("declarations.c"));
    expect(values[0]).toMatchObject({
      callee: "make",
      binding: "unknown",
      owner: { kind: "variable", name: "local" },
    });
    expect(values.find((fact) => fact.callee === "callback")).toMatchObject({
      binding: "local",
      owner: { kind: "function", name: "execute" },
    });
    expect(values.find((fact) => fact.callee === "handler")?.target).toMatchObject({
      kind: "function",
      name: "handler",
    });
  });

  test("does not fabricate export facts from C linkage", async () => {
    expect((await facts("api.h")).some((fact) => fact.kind === "export")).toBe(false);
  });

  test("scopes for initializers and nested blocks without leaking bindings", async () => {
    const values = calls(await facts("control-flow.c"));
    expect(values.map((fact) => [
      fact.callee,
      fact.startLine,
      fact.binding,
      fact.owner?.name ?? null,
    ])).toEqual([
      ["factory", 4, "local", "loop"],
      ["factory", 4, "local", "control_flow"],
      ["loop", 5, "local", "control_flow"],
      ["loop", 7, "unknown", "control_flow"],
      ["item", 11, "local", "control_flow"],
      ["item", 13, "unknown", "control_flow"],
    ]);
  });

  test("respects declaration timing, reassignment, and direct binding forms", async () => {
    const values = calls(await facts("shadowing.c"));
    const selected = values.filter((fact) =>
      ["target", "first", "second", "nested", "object", "values"].includes(fact.callee)
    );
    expect(selected.map((fact) => [fact.callee, fact.startLine, fact.binding])).toEqual([
      ["target", 8, "source-chunk"],
      ["target", 11, "local"],
      ["target", 14, "local"],
      ["first", 17, "local"],
      ["second", 18, "local"],
      ["nested", 22, "local"],
      ["nested", 24, "unknown"],
      ["object", 27, "unknown"],
      ["values", 29, "unknown"],
    ]);
    expect(selected[0]?.target).toMatchObject({
      kind: "function",
      name: "target",
      startLine: 4,
    });
  });

  test("keeps conditional macro definitions branch-local", async () => {
    const values = calls(await facts("conditional-macros.c"));
    expect(values.map((fact) => [
      fact.startLine,
      fact.binding,
      fact.target?.startLine ?? null,
    ])).toEqual([
      [4, "source-chunk", 2],
      [9, "source-chunk", 7],
      [14, "unknown", null],
    ]);
  });
});
