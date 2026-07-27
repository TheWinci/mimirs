import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  chunk,
  type CallFact,
  type ImportFact,
  type SourceFact,
} from "@winci/bun-chunk";

const FIXTURES = join(import.meta.dir, "fixtures", "bash");

async function result(fixture: string) {
  const path = join(FIXTURES, fixture);
  return chunk(path, await Bun.file(path).text());
}

function calls(values: SourceFact[]): CallFact[] {
  return values.filter((fact): fact is CallFact => fact.kind === "call");
}

describe("Bash source fact bindings", () => {
  test("treats only literal source commands as imports", async () => {
    const values = (await result("imports.sh")).facts;
    expect(
      values
        .filter((fact): fact is ImportFact => fact.kind === "import")
        .map((fact) => [fact.source, fact.imported]),
    ).toEqual([
      ["./lib.sh", "source"],
      ["./config.sh", "."],
    ]);
    expect(
      calls(values).find((fact) => fact.callee === "source"),
    ).toMatchObject({ binding: "unknown", owner: null });
  });

  test("targets prior and recursive functions without resolving PATH calls", async () => {
    const values = calls((await result("functions.sh")).facts);
    expect(
      values.find((fact) => fact.callee === "helper")?.target,
    ).toMatchObject({ kind: "function", name: "helper" });
    expect(
      values.find((fact) => fact.callee === "run" && fact.owner?.name === "run")
        ?.target,
    ).toMatchObject({ kind: "function", name: "run" });
    expect(values.find((fact) => fact.callee === "run_child")?.binding).toBe(
      "unknown",
    );
  });

  test("binds dynamic commands to prior shell variables", async () => {
    const values = calls((await result("scope.sh")).facts);
    expect(values.find((fact) => fact.callee === '"$callback"')).toMatchObject({
      binding: "local",
      owner: { kind: "function", name: "run" },
    });
    expect(
      values.find((fact) => fact.callee === "helper")?.target,
    ).toMatchObject({ kind: "function", name: "helper" });
  });

  test("owns substitution calls by variables and excludes environment prefixes", async () => {
    const value = await result("variables.sh");
    expect(
      calls(value.facts).find((fact) => fact.callee === "load")?.owner,
    ).toMatchObject({ kind: "variable", name: "result" });
    expect(
      calls(value.facts).find((fact) => fact.callee === "command")?.owner,
    ).toBeNull();
    expect(value.chunks.some((chunk) => chunk.name === "foo")).toBe(false);
  });

  test("distinguishes readonly declarations from mutable assignments", async () => {
    const value = await result("variables.sh");
    expect(value.chunks.map((chunk) => [chunk.name, chunk.kind])).toEqual([
      ["NAME", "variable"],
      ["LIMIT", "constant"],
      ["PATH", "variable"],
      ["FIXED", "constant"],
      ["COUNT", "constant"],
      [null, "gap"],
      ["result", "variable"],
      ["items", "variable"],
      [null, "block"],
    ]);
  });

  test("preserves every executable command in pipelines and control flow", async () => {
    expect(
      calls((await result("control.sh")).facts).map((fact) => fact.callee),
    ).toEqual([
      "produce",
      "transform",
      "consume",
      "check_ready",
      "start_service",
      "report_failure",
      "process",
    ]);
  });

  test("routes the .bash extension through the reviewed implementation", async () => {
    const value = await result("extension.bash");
    expect(value.language).toBe("bash");
    expect(
      calls(value.facts).find((fact) => fact.callee === "bootstrap")?.target,
    ).toMatchObject({ kind: "function", name: "bootstrap" });
  });

  test("does not fabricate Bash export facts", async () => {
    expect(
      (await result("variables.sh")).facts.some(
        (fact) => fact.kind === "export",
      ),
    ).toBe(false);
  });

  test("BASH-L1 binds loop variables and declaration commands in shell scope", async () => {
    const values = calls((await result("bindings.sh")).facts);
    expect(values.filter((fact) => [3, 5, 8, 11, 16, 19, 22, 24].includes(fact.startLine)).map(
      (fact) => [fact.startLine, fact.callee, fact.binding],
    )).toEqual([
      [3, '"$callback"', "local"],
      [5, '"$callback"', "local"],
      [8, '"$choice"', "local"],
      [11, '"$choice"', "local"],
      [16, '"$before"', "local"],
      [19, '"$declared"', "local"],
      [22, '"$item"', "local"],
      [24, '"$item"', "local"],
    ]);
    expect(values.find((fact) => fact.startLine === 14)).toMatchObject({
      callee: '"$before"',
      binding: "unknown",
    });
  });

  test("BASH-L2 preserves branch bindings and isolates child-process mutations", async () => {
    const values = calls((await result("bindings.sh")).facts);
    expect(values.filter((fact) => [28, 30, 34, 36, 40, 42].includes(fact.startLine)).map(
      (fact) => [fact.startLine, fact.callee, fact.binding],
    )).toEqual([
      [28, '"$conditional"', "local"],
      [30, '"$conditional"', "local"],
      [34, '"$isolated"', "local"],
      [36, '"$isolated"', "unknown"],
      [40, '"$nested"', "local"],
      [42, '"$nested"', "unknown"],
    ]);
  });

  test("BASH-E1 treats literal source as a dependency only before function shadowing", async () => {
    const values = (await result("source-shadowing.sh")).facts;
    expect(values.filter((fact): fact is ImportFact => fact.kind === "import").map(
      (fact) => [fact.source, fact.imported, fact.startLine],
    )).toEqual([["./before.sh", "source", 1]]);
    expect(calls(values).find((fact) => fact.startLine === 7)).toMatchObject({
      callee: "source",
      binding: "source-chunk",
      target: { kind: "function", name: "source", startLine: 3 },
    });
  });

  test("BASH-L3 follows unconditional function order without leaking branch definitions", async () => {
    expect(calls((await result("overrides.sh")).facts).filter(
      (fact) => [5, 11, 17, 20].includes(fact.startLine),
    ).map((fact) => [
      fact.startLine,
      fact.callee,
      fact.binding,
      fact.target?.startLine ?? null,
    ])).toEqual([
      [5, "task", "source-chunk", 1],
      [11, "task", "source-chunk", 7],
      [17, "branch", "source-chunk", 14],
      [20, "branch", "unknown", null],
    ]);
  });

  test("BASH-E2 keeps static command and expanded-variable namespaces distinct", async () => {
    const values = calls((await result("bindings.sh")).facts);
    expect(values.find((fact) => fact.startLine === 47)).toMatchObject({
      callee: "callback",
      binding: "unknown",
    });
  });
});
