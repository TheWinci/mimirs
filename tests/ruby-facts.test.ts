import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { chunk, type CallFact, type ImportFact } from "@winci/bun-chunk";

const FIXTURES = join(import.meta.dir, "fixtures", "ruby");

async function facts(fixture: string) {
  const path = join(FIXTURES, fixture);
  return (await chunk(path, await Bun.file(path).text())).facts;
}

function calls(values: Awaited<ReturnType<typeof facts>>): CallFact[] {
  return values.filter((fact): fact is CallFact => fact.kind === "call");
}

describe("Ruby source fact bindings", () => {
  test("extracts only receiverless literal require forms as imports", async () => {
    const values = await facts("imports.rb");
    const imports = values.filter(
      (fact): fact is ImportFact => fact.kind === "import",
    );
    expect(imports.map((fact) => [fact.source, fact.imported])).toEqual([
      ["json", "require"],
      ["set", "require"],
      ["support/worker", "require_relative"],
      ["setup.rb", "load"],
    ]);
    expect(calls(values).map((fact) => [fact.callee, fact.binding])).toEqual([
      ["require", "unknown"],
      ["require", "unknown"],
      ["loader.require", "local"],
    ]);
  });

  test("binds parameters, unique methods, yield, and super", async () => {
    const values = calls(await facts("methods.rb"));
    expect(values.find((fact) => fact.callee === "helper")).toMatchObject({
      binding: "source-chunk",
      target: { kind: "method", name: "helper" },
    });
    expect(
      values.find((fact) => fact.callee === "callback.call")?.binding,
    ).toBe("local");
    expect(values.find((fact) => fact.callee === "yield")?.binding).toBe(
      "local",
    );
    expect(values.find((fact) => fact.callee === "super")?.binding).toBe(
      "local",
    );
  });

  test("targets named lambdas and binds block parameters", async () => {
    const values = calls(await facts("closures.rb"));
    expect(
      values.find((fact) => fact.callee === "normalize.call")?.target,
    ).toMatchObject({ kind: "function", name: "normalize" });
    expect(
      values.find((fact) => fact.callee === "NORMALIZE.call")?.target,
    ).toMatchObject({ kind: "function", name: "NORMALIZE" });
    expect(values.find((fact) => fact.callee === "items.map")?.binding).toBe(
      "local",
    );
    expect(values.find((fact) => fact.callee === "item.call")?.binding).toBe(
      "local",
    );
  });

  test("uses Ruby lexical assignment scope even before the assignment executes", async () => {
    const values = calls(await facts("scope.rb"));
    expect(
      values.find((fact) => fact.callee === "callback.call")?.target,
    ).toMatchObject({ kind: "function", name: "callback" });
    expect(
      values.find((fact) => fact.callee === "helper")?.target,
    ).toMatchObject({ kind: "method", name: "helper" });
  });

  test("preserves safe navigation, scope resolution, and chained call spelling", async () => {
    const values = calls(await facts("calls.rb"));
    expect(values.map((fact) => fact.callee)).toEqual([
      "new",
      "service.call",
      "service&.execute",
      "Worker.create",
      "Worker::create",
      "factory",
      "factory().build",
    ]);
    expect(
      values.find((fact) => fact.callee === "Worker.create")?.target,
    ).toMatchObject({ kind: "class", name: "Worker" });
  });

  test("does not fabricate export facts from Ruby constants", async () => {
    expect(
      (await facts("classes.rb")).some((fact) => fact.kind === "export"),
    ).toBe(false);
  });

  test("owns operator and setter calls by their exact method names", async () => {
    expect(calls(await facts("syntax.rb")).map((fact) => [
      fact.callee,
      fact.owner?.name,
    ])).toEqual([
      ["combine", "+"],
      ["store", "value="],
    ]);
  });

  test("RUBY-L1 binds blocks, numbered parameters, loops, rescue, and patterns", async () => {
    const values = calls(await facts("control_flow.rb"));
    const binding = (line: number, callee: string) =>
      values.find((fact) => fact.startLine === line && fact.callee === callee)?.binding;
    expect([
      binding(3, "item.call"),
      binding(5, "block_local.call"),
      binding(11, "_1.call"),
      binding(16, "entry.call"),
      binding(18, "entry.call"),
      binding(23, "failure.message"),
      binding(25, "failure.message"),
      binding(29, "first.call"),
      binding(30, "rest.each"),
      binding(34, "first.call"),
      binding(35, "rest.each"),
    ]).toEqual([
      "local",
      "source-chunk",
      "local",
      "local",
      "local",
      "local",
      "local",
      "local",
      "local",
      "local",
      "local",
    ]);
    expect([
      binding(7, "item.call"),
      binding(8, "block_local.call"),
      binding(13, "_1.call"),
    ]).toEqual(Array(3).fill("unknown"));
  });

  test("RUBY-L2 keeps redefined methods conservative", async () => {
    expect(calls(await facts("redefinitions.rb"))).toEqual([
      expect.objectContaining({
        callee: "duplicate",
        binding: "local",
        target: null,
        owner: expect.objectContaining({ kind: "method", name: "run" }),
      }),
    ]);
  });

  test("RUBY-E1 retains literal loaders only when standard methods are unshadowed", async () => {
    const values = await facts("loaders.rb");
    expect(values.filter((fact): fact is ImportFact => fact.kind === "import").map(
      (fact) => [fact.source, fact.imported, fact.local],
    )).toEqual([
      ["real", "require", null],
      ["support/local", "require_relative", null],
      ["config/setup.rb", "load", null],
      ["workers/worker.rb", "autoload", "Worker"],
      ["after-class", "require", null],
    ]);
    expect(calls(values).map((fact) => [fact.startLine, fact.callee, fact.binding])).toEqual([
      [7, "require", "local"],
      [16, "require", "source-chunk"],
    ]);
  });

  test("RUBY-E2 preserves operator, index, and setter call syntax", async () => {
    expect(calls(await facts("operators.rb")).map((fact) => [
      fact.callee,
      fact.binding,
      fact.owner?.name,
    ])).toEqual([
      ["left.+", "local", "operate"],
      ["left.-@", "local", "operate"],
      ["container.[]", "local", "operate"],
      ["container.[]=", "local", "operate"],
      ["container.value=", "local", "operate"],
    ]);
  });
});
