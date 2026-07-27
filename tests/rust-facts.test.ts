import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { chunk, type CallFact, type ImportFact } from "@winci/bun-chunk";

const FIXTURES = join(import.meta.dir, "fixtures", "rust");

async function facts(fixture: string) {
  const path = join(FIXTURES, fixture);
  return (await chunk(path, await Bun.file(path).text())).facts;
}

function calls(values: Awaited<ReturnType<typeof facts>>): CallFact[] {
  return values.filter((fact): fact is CallFact => fact.kind === "call");
}

describe("Rust source fact bindings", () => {
  test("expands grouped use declarations into complete Rust paths", async () => {
    const values = await facts("imports.rs");
    const imports = values
      .filter((fact): fact is ImportFact => fact.kind === "import");

    expect(imports.map((fact) => [fact.source, fact.local])).toEqual([
      ["std::collections::HashMap", "HashMap"],
      ["crate::worker", "worker"],
      ["crate::worker::run", "run"],
      ["crate::worker::Task", "Work"],
      ["crate::model::user::User", "User"],
      ["crate::model::user::Role", "UserRole"],
      ["crate::model", null],
      ["super", null],
      ["crate::local::run", "local_run"],
    ]);
    expect(imports.at(-1)?.owner).toMatchObject({
      kind: "function",
      name: "use_local_import",
    });
    expect(calls(values).map((fact) => [fact.callee, fact.binding])).toEqual([
      ["HashMap::new", "import"],
      ["worker::start", "import"],
      ["run", "import"],
      ["Work::new", "import"],
      ["crate::worker::finish", "unknown"],
      ["local_run", "import"],
    ]);
  });

  test("resolves parameters and named local closures", async () => {
    const values = calls(await facts("functions.rs"));
    expect(values.map((fact) => [fact.callee, fact.binding])).toEqual([
      ["format_name", "unknown"],
      ["loader", "local"],
      ["clean", "unknown"],
      ["normalize", "source-chunk"],
    ]);
    expect(values.at(-1)?.target).toMatchObject({ kind: "function", name: "normalize" });
  });

  test("honors lexical shadowing and block-local uses", async () => {
    const values = calls(await facts("scope.rs"));
    expect(values.map((fact) => [fact.callee, fact.binding])).toEqual([
      ["run", "local"],
      ["callback", "local"],
      ["run", "import"],
      ["late_run", "import"],
      ["helper", "source-chunk"],
    ]);
    expect(values.at(-1)?.target).toMatchObject({ kind: "function", name: "helper" });
  });

  test("targets local types and generic functions", async () => {
    const typeCalls = calls(await facts("types.rs"));
    expect(typeCalls[0]).toMatchObject({
      callee: "State::Done",
      binding: "source-chunk",
      target: { kind: "constant", name: "Done" },
    });

    const genericCalls = calls(await facts("generics.rs"));
    expect(genericCalls[0]).toMatchObject({
      callee: "identity::<String>",
      binding: "source-chunk",
      target: { kind: "function", name: "identity" },
    });
  });

  test("resolves self parameters and locally defined macros", async () => {
    const methodCalls = calls(await facts("traits.rs"));
    expect(methodCalls.at(-1)).toMatchObject({
      callee: "self.validate",
      binding: "local",
      owner: { kind: "method", name: "run" },
    });

    const [macroCall, functionCall] = calls(await facts("macros.rs"));
    expect(macroCall).toMatchObject({
      callee: "trace!",
      binding: "source-chunk",
      target: { kind: "macro", name: "trace", startLine: 1 },
    });
    expect(functionCall).toMatchObject({
      callee: "trace",
      binding: "source-chunk",
      target: { kind: "function", name: "trace", startLine: 7 },
    });
  });

  test("does not fabricate export facts from pub visibility", async () => {
    expect((await facts("types.rs")).some((fact) => fact.kind === "export")).toBe(false);
  });

  test("RS-L1 scopes control-flow and destructuring patterns without leaks", async () => {
    const values = calls(await facts("control-flow.rs"));
    expect(
      values.map((fact) => [fact.callee, fact.startLine, fact.binding]),
    ).toEqual([
      ["source", 6, "local"],
      ["selected", 7, "local"],
      ["selected", 9, "unknown"],
      ["selected", 11, "unknown"],
      ["source", 13, "local"],
      ["current", 14, "local"],
      ["current", 16, "unknown"],
      ["values.into_iter", 18, "local"],
      ["values.into_iter().enumerate", 18, "local"],
      ["item", 19, "local"],
      ["item", 21, "unknown"],
      ["guard", 24, "unknown"],
      ["matched", 24, "local"],
      ["fallback", 25, "unknown"],
      ["fallback", 26, "unknown"],
      ["matched", 28, "unknown"],
      ["source", 30, "local"],
      ["finalized", 31, "unknown"],
      ["finalized", 34, "local"],
      ["point", 36, "unknown"],
      ["callback", 37, "local"],
      ["alias", 38, "local"],
    ]);
  });

  test("RS-L2 respects let timing, reassignment, and nested block boundaries", async () => {
    const values = calls(await facts("shadowing.rs"));
    expect(
      values.filter((fact) => fact.callee === "target")
        .map((fact) => [fact.startLine, fact.binding, fact.target?.startLine ?? null]),
    ).toEqual([
      [5, "source-chunk", 1],
      [7, "source-chunk", 4],
    ]);
    expect(
      values.filter((fact) => fact.callee === "callback")
        .map((fact) => [fact.startLine, fact.binding, fact.target?.startLine ?? null]),
    ).toEqual([
      [10, "source-chunk", 9],
      [12, "local", null],
    ]);
    expect(
      values.filter((fact) => ["nested", "object", "values"].includes(fact.callee))
        .map((fact) => [fact.callee, fact.startLine, fact.binding]),
    ).toEqual([
      ["nested", 20, "local"],
      ["nested", 22, "unknown"],
      ["object", 25, "unknown"],
      ["values", 27, "unknown"],
    ]);
  });

  test("RS-E1 resolves explicit variants and inherent associated calls conservatively", async () => {
    const values = calls(await facts("associated.rs"));
    expect(
      values.map((fact) => [
        fact.callee,
        fact.binding,
        fact.target?.kind ?? null,
        fact.target?.name ?? null,
      ]),
    ).toEqual([
      ["Self::helper", "source-chunk", "method", "helper"],
      ["self.helper", "local", null, null],
      ["self.helper", "local", null, null],
      ["State::Done", "source-chunk", "constant", "Done"],
      ["String::new", "unknown", null, null],
      ["Worker::new", "source-chunk", "method", "new"],
      ["worker.execute", "local", null, null],
      ["Runner::execute", "local", null, null],
    ]);
  });

  test("RS-E2 preserves extern crate dependencies and aliases", async () => {
    const values = await facts("extern-crates.rs");
    const imports = values.filter(
      (fact): fact is ImportFact => fact.kind === "import",
    );
    expect(imports.map((fact) => [fact.source, fact.local])).toEqual([
      ["alloc", "alloc"],
      ["core", "rust_core"],
    ]);
    expect(calls(values).map((fact) => [fact.callee, fact.binding])).toEqual([
      ["alloc::boxed::Box::new", "import"],
      ["rust_core::mem::size_of::<usize>", "import"],
    ]);
  });
});
