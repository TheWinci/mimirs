import { describe, expect, test } from "bun:test";
import { extname, join } from "node:path";

import {
  chunk,
  EXTENSION_MAP,
  textOf,
  type SourceChunk,
} from "@winci/bun-chunk";

import { renderSourceWindowTree } from "../src/cli/renderers/source-windows.ts";
import {
  projectSourceWindows,
  sourceWindowPreview,
  type SourceWindow,
} from "../src/internals/source/windows.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "source-windows");
const GOLDENS = join(import.meta.dir, "goldens", "source-windows");

type ReviewedCase = readonly [name: string, targetCharacters: number];
const REVIEWED_CASE_PATHS = new Set<string>();

const TYPESCRIPT_CASES = [
  ["small-function.ts", 240],
  ["oversized-function.ts", 260],
  ["nested-class.ts", 180],
  ["module-blocks.ts", 140],
  ["comments.ts", 180],
] as const;

async function project(
  language: string,
  name: string,
  targetCharacters: number,
) {
  const path = `tests/fixtures/source-windows/${language}/${name}`;
  const source = await Bun.file(join(FIXTURES, language, name)).text();
  const result = await chunk(path, source);
  return {
    path,
    source,
    chunks: result.chunks,
    windows: projectSourceWindows(path, result.chunks, { targetCharacters }),
  };
}

function expectExactProjection(
  path: string,
  source: string,
  chunks: SourceChunk[],
  windows: SourceWindow[],
): void {
  const roots = chunks.filter((sourceChunk) => sourceChunk.kind !== "gap");
  expect(windows.every((window) => window.sourceChunk.kind !== "gap")).toBe(true);
  expect(windows.every((window) => window.text.trim() !== "")).toBe(true);

  for (const root of roots) {
    const owned = windows.filter((window) => window.sourceChunk === root);
    expect(owned.length).toBeGreaterThan(0);
    expect(owned[0]!.startOffset).toBe(root.startOffset);
    expect(owned.at(-1)!.endOffset).toBe(root.endOffset);
    expect(owned.map((window) => window.text).join("")).toBe(textOf(root));

    for (let index = 0; index < owned.length; index++) {
      const window = owned[index]!;
      expect(window.text).toBe(source.slice(window.startOffset, window.endOffset));
      expect(window.path).toBe(path);
      if (index > 0) {
        expect(owned[index - 1]!.endOffset).toBe(window.startOffset);
        const lineStart = source.lastIndexOf("\n", window.startOffset - 1) + 1;
        const prefix = source.slice(lineStart, window.startOffset);
        expect(prefix.length > 0 && prefix.trim() === "").toBe(false);
      }
    }
  }
}

function sourceWindowGoldenName(name: string): string {
  const firstDot = name.indexOf(".");
  return `${firstDot < 0 ? name : name.slice(0, firstDot)}.windows.txt`;
}

function reviewCases(language: string, cases: readonly ReviewedCase[]): void {
  for (const [name, targetCharacters] of cases) {
    const casePath = `${language}/${name}`;
    if (REVIEWED_CASE_PATHS.has(casePath)) {
      throw new Error(`duplicate source-window review case: ${casePath}`);
    }
    REVIEWED_CASE_PATHS.add(casePath);
    test(`${name} matches its reviewed projection`, async () => {
      const value = await project(language, name, targetCharacters);
      const repeated = await project(language, name, targetCharacters);
      const goldenName = sourceWindowGoldenName(name);
      const golden = await Bun.file(
        join(GOLDENS, language, goldenName),
      ).text();

      const rendered = renderSourceWindowTree(value.path, value.windows);
      expect(rendered).toBe(golden.trimEnd());
      expect(renderSourceWindowTree(repeated.path, repeated.windows)).toBe(
        rendered,
      );
      expectExactProjection(
        value.path,
        value.source,
        value.chunks,
        value.windows,
      );
    });
  }
}

describe("TypeScript source windows", () => {
  reviewCases("typescript", TYPESCRIPT_CASES);

  test("keeps a small source chunk as one window", async () => {
    const value = await project("typescript", "small-function.ts", 240);
    expect(value.windows).toHaveLength(1);
    expect(value.windows[0]!.sourceChunk.kind).toBe("function");
  });

  test("uses nested boundaries without creating overlapping child documents", async () => {
    const value = await project("typescript", "nested-class.ts", 180);
    expect(value.windows.length).toBeGreaterThan(1);
    expect(value.windows.every((window) => window.sourceChunk.kind === "class"))
      .toBe(true);
    expect(new Set(value.windows.map((window) => window.sourceChunk)).size)
      .toBe(1);
    expect(value.windows.some((window) => window.text.includes("get(id:"))).toBe(true);
    expect(value.windows.some((window) => window.text.includes("snapshot()"))).toBe(true);
  });

  test("excludes top-level gaps but retains module-level source blocks", async () => {
    const value = await project("typescript", "module-blocks.ts", 140);
    expect(value.windows.map((window) => window.sourceChunk.kind)).toEqual([
      "type",
      "variable",
      "function",
      "block",
    ]);
    expect(value.windows.at(-1)!.text).toContain("initialize(config);");
  });

  test("preserves attached, standalone, and trailing comments", async () => {
    const value = await project("typescript", "comments.ts", 180);
    expect(value.windows[0]!.text).toStartWith("/**");
    expect(value.windows[1]!.sourceChunk.kind).toBe("comment");
    expect(value.windows[2]!.text).toContain("trailing comment");
  });

  test("is deterministic", async () => {
    const first = await project("typescript", "oversized-function.ts", 260);
    const second = await project("typescript", "oversized-function.ts", 260);
    expect(renderSourceWindowTree(first.path, first.windows)).toBe(
      renderSourceWindowTree(second.path, second.windows),
    );
  });

  test("keeps full text while returning a compact preview", async () => {
    const value = await project("typescript", "small-function.ts", 240);
    const window = value.windows[0]!;
    const text = window.text;
    expect(sourceWindowPreview(window, 32)).toBe(
      "/** Format one user for display…",
    );
    expect(window.text).toBe(text);
    expect(window.text.length).toBeGreaterThan(32);
  });

  test("allows one indivisible line to exceed the soft target", async () => {
    const source = `export const value = "${"x".repeat(80)}";\n`;
    const result = await chunk("long-line.ts", source);
    const windows = projectSourceWindows("long-line.ts", result.chunks, {
      targetCharacters: 20,
    });
    expect(windows).toHaveLength(1);
    expect(windows[0]!.text).toBe(source);
    expect(windows[0]!.text.length).toBeGreaterThan(20);
  });

  test("rejects invalid target and preview sizes", async () => {
    const value = await project("typescript", "small-function.ts", 240);
    expect(() =>
      projectSourceWindows(value.path, value.chunks, { targetCharacters: 0 })
    ).toThrow("targetCharacters must be a positive integer");
    expect(() => sourceWindowPreview(value.windows[0]!, 0)).toThrow(
      "maxCharacters must be a positive integer",
    );
  });
});

const JAVASCRIPT_CASES = [
  ["small-function.js", 220],
  ["oversized-class.js", 160],
  ["module-comments.js", 150],
] as const;

describe("JavaScript source windows", () => {
  reviewCases("javascript", JAVASCRIPT_CASES);

  test("splits a nested class without creating method documents", async () => {
    const value = await project("javascript", "oversized-class.js", 160);
    expect(value.windows).toHaveLength(4);
    expect(value.windows.every((window) => window.sourceChunk.kind === "class"))
      .toBe(true);
    expect(new Set(value.windows.map((window) => window.sourceChunk)).size)
      .toBe(1);
  });

  test("retains ESM declarations, a standalone comment, and an eager call", async () => {
    const value = await project("javascript", "module-comments.js", 150);
    expect(value.windows.map((window) => window.sourceChunk.kind)).toEqual([
      "import",
      "variable",
      "function",
      "comment",
      "block",
    ]);
    expect(value.windows.at(-1)!.text).toContain("initialize(");
  });
});

const PYTHON_CASES = [
  ["small-function.py", 220],
  ["oversized-class.py", 220],
  ["nested-function.py", 220],
  ["module-comments.py", 150],
] as const;

describe("Python source windows", () => {
  reviewCases("python", PYTHON_CASES);

  test("keeps decorators and class methods under one non-overlapping parent", async () => {
    const value = await project("python", "oversized-class.py", 220);
    const classWindows = value.windows.filter(
      (window) => window.sourceChunk.kind === "class",
    );
    expect(classWindows).toHaveLength(4);
    expect(classWindows[0]!.text).toStartWith("@dataclass");
    expect(new Set(classWindows.map((window) => window.sourceChunk)).size)
      .toBe(1);
  });

  test("uses nested function definitions as boundaries, not documents", async () => {
    const value = await project("python", "nested-function.py", 220);
    expect(value.windows).toHaveLength(4);
    expect(
      value.windows.every(
        (window) => window.sourceChunk.name === "build_report",
      ),
    ).toBe(true);
    expect(value.windows.some((window) => window.text.includes("def normalize")))
      .toBe(true);
    expect(value.windows.some((window) => window.text.includes("def render")))
      .toBe(true);
  });

  test("retains docstrings, standalone comments, and module-level calls", async () => {
    const small = await project("python", "small-function.py", 220);
    const module = await project("python", "module-comments.py", 150);
    expect(small.windows[0]!.text).toContain('"""Format one account');
    expect(module.windows.map((window) => window.sourceChunk.kind)).toEqual([
      "import",
      "variable",
      "function",
      "comment",
      "block",
    ]);
  });
});

const GO_CASES = [
  ["small-function.go", 260],
  ["oversized-function.go", 400],
  ["types-and-methods.go", 220],
  ["comments.go", 180],
] as const;

describe("Go source windows", () => {
  reviewCases("go", GO_CASES);

  test("splits an oversized function while retaining declaration context", async () => {
    const value = await project("go", "oversized-function.go", 400);
    const functionWindows = value.windows.filter(
      (window) => window.sourceChunk.name === "BuildReport",
    );
    expect(functionWindows).toHaveLength(2);
    expect(functionWindows[0]!.text).toStartWith("func BuildReport");
    expect(functionWindows[1]!.text).toContain("return strings.Join");
  });

  test("keeps Go methods as independent top-level parents", async () => {
    const value = await project("go", "types-and-methods.go", 220);
    expect(value.windows.map((window) => window.sourceChunk.kind)).toEqual([
      "package",
      "struct",
      "function",
      "method",
      "method",
      "method",
    ]);
    expect(
      value.windows.slice(3).map((window) => window.sourceChunk.name),
    ).toEqual(["Enqueue", "Peek", "Drain"]);
  });

  test("attaches doc comments and preserves a standalone comment", async () => {
    const small = await project("go", "small-function.go", 260);
    const comments = await project("go", "comments.go", 180);
    expect(small.windows[0]!.text).toStartWith("// Package windows");
    expect(small.windows[1]!.text).toStartWith("// FormatAccount");
    expect(comments.windows.at(-1)!.sourceChunk.kind).toBe("comment");
  });
});

const RUST_CASES = [
  ["impl-and-functions.rs", 230],
  ["modules-comments.rs", 160],
] as const;

describe("Rust source windows", () => {
  reviewCases("rust", RUST_CASES);

  test("uses impl methods as boundaries under one non-overlapping parent", async () => {
    const value = await project("rust", "impl-and-functions.rs", 230);
    const implWindows = value.windows.filter(
      (window) => window.sourceChunk.kind === "impl",
    );
    expect(implWindows).toHaveLength(2);
    expect(new Set(implWindows.map((window) => window.sourceChunk)).size)
      .toBe(1);
    expect(implWindows[0]!.text).toContain("pub fn new");
    expect(implWindows[1]!.text).toContain("pub fn render");
  });

  test("keeps use items, constants, doc comments, and standalone comments", async () => {
    const value = await project("rust", "modules-comments.rs", 160);
    expect(value.windows.map((window) => window.sourceChunk.kind)).toEqual([
      "import",
      "constant",
      "function",
      "comment",
    ]);
    expect(value.windows[2]!.text).toStartWith("/// Return");
  });
});

const JAVA_CASES = [
  ["nested-class.java", 260],
  ["module-comments.java", 220],
] as const;

describe("Java source windows", () => {
  reviewCases("java", JAVA_CASES);

  test("uses methods and a nested record as class window boundaries", async () => {
    const value = await project("java", "nested-class.java", 260);
    const classWindows = value.windows.filter(
      (window) => window.sourceChunk.kind === "class",
    );
    expect(classWindows).toHaveLength(3);
    expect(new Set(classWindows.map((window) => window.sourceChunk)).size)
      .toBe(1);
    expect(classWindows.at(-1)!.text).toContain("record Entry");
  });

  test("keeps package docs, grouped imports, enums, and comments", async () => {
    const value = await project("java", "module-comments.java", 220);
    expect(value.windows.map((window) => window.sourceChunk.kind)).toEqual([
      "package",
      "import",
      "enum",
      "comment",
    ]);
    expect(value.windows[0]!.text).toStartWith("/** Source-window");
  });
});

const C_CASES = [
  ["structs-and-functions.c", 260],
  ["preprocessor-comments.c", 200],
] as const;

describe("C source windows", () => {
  reviewCases("c", C_CASES);

  test("keeps includes and typedefs separate from function windows", async () => {
    const value = await project("c", "structs-and-functions.c", 260);
    expect(value.windows.map((window) => window.sourceChunk.kind)).toEqual([
      "import",
      "type",
      "function",
      "function",
      "function",
    ]);
    const split = value.windows.filter(
      (window) => window.sourceChunk.name === "report_visible_count",
    );
    expect(split).toHaveLength(2);
    expect(new Set(split.map((window) => window.sourceChunk)).size).toBe(1);
  });

  test("retains preprocessor conditionals as meaningful parents", async () => {
    const value = await project("c", "preprocessor-comments.c", 200);
    expect(value.windows.map((window) => window.sourceChunk.kind)).toEqual([
      "import",
      "macro",
      "conditional",
      "function",
      "comment",
    ]);
    expect(value.windows[2]!.text).toContain("#else");
  });
});

const CPP_CASES = [
  ["namespace-class.cpp", 260],
  ["templates-comments.cpp", 220],
] as const;

describe("C++ source windows", () => {
  reviewCases("cpp", CPP_CASES);

  test("uses namespace members and class members as module boundaries", async () => {
    const value = await project("cpp", "namespace-class.cpp", 260);
    const namespaceWindows = value.windows.filter(
      (window) => window.sourceChunk.kind === "module",
    );
    expect(namespaceWindows).toHaveLength(3);
    expect(new Set(namespaceWindows.map((window) => window.sourceChunk)).size)
      .toBe(1);
    expect(namespaceWindows[0]!.text).toStartWith("namespace windows");
    expect(namespaceWindows.at(-1)!.text).toContain("struct Entry");
  });

  test("keeps templates, conditionals, and comments as reviewed parents", async () => {
    const value = await project("cpp", "templates-comments.cpp", 220);
    expect(value.windows.map((window) => window.sourceChunk.kind)).toEqual([
      "import",
      "class",
      "conditional",
      "comment",
    ]);
    expect(value.windows[1]!.text).toStartWith("template <typename Value>");
  });
});

const CSHARP_CASES = [
  ["namespace-class.cs", 260],
  ["modern-types-comments.cs", 200],
] as const;

describe("C# source windows", () => {
  reviewCases("csharp", CSHARP_CASES);

  test("uses namespace and class members as module boundaries", async () => {
    const value = await project("csharp", "namespace-class.cs", 260);
    const moduleWindows = value.windows.filter(
      (window) => window.sourceChunk.kind === "module",
    );
    expect(moduleWindows).toHaveLength(4);
    expect(new Set(moduleWindows.map((window) => window.sourceChunk)).size)
      .toBe(1);
    expect(moduleWindows[0]!.text).toContain("class ReportBook");
    expect(moduleWindows.at(-1)!.text).toContain("record Entry");
  });

  test("keeps file-scoped namespace contents under the namespace parent", async () => {
    const value = await project("csharp", "modern-types-comments.cs", 200);
    expect(value.windows).toHaveLength(2);
    expect(value.windows.every((window) => window.sourceChunk.kind === "module"))
      .toBe(true);
    expect(value.windows.at(-1)!.text).toContain("final comment");
  });
});

const RUBY_CASES = [
  ["module-class.rb", 220],
  ["loaders-comments.rb", 160],
] as const;

describe("Ruby source windows", () => {
  reviewCases("ruby", RUBY_CASES);

  test("uses nested classes and methods as module boundaries", async () => {
    const value = await project("ruby", "module-class.rb", 220);
    expect(value.windows).toHaveLength(2);
    expect(value.windows.every((window) => window.sourceChunk.kind === "module"))
      .toBe(true);
    expect(value.windows[0]!.text).toStartWith("module Windows");
    expect(value.windows[1]!.text).toContain("def render");
  });

  test("keeps runtime loaders as blocks without losing comments", async () => {
    const value = await project("ruby", "loaders-comments.rb", 160);
    expect(value.windows.map((window) => window.sourceChunk.kind)).toEqual([
      "block",
      "constant",
      "method",
      "comment",
    ]);
    expect(value.windows[0]!.text).toContain('require "json"');
  });
});

const PHP_CASES = [
  ["namespace-class.php", 280],
  ["runtime-comments.php", 180],
] as const;

describe("PHP source windows", () => {
  reviewCases("php", PHP_CASES);

  test("keeps the open tag separate from namespace-owned declarations", async () => {
    const value = await project("php", "namespace-class.php", 280);
    expect(value.windows[0]!.sourceChunk.kind).toBe("block");
    expect(value.windows[0]!.text).toBe("<?php\n");
    const namespaceWindows = value.windows.slice(1);
    expect(namespaceWindows).toHaveLength(3);
    expect(namespaceWindows.every((window) => window.sourceChunk.kind === "module"))
      .toBe(true);
  });

  test("retains runtime imports, constants, docs, and comments", async () => {
    const value = await project("php", "runtime-comments.php", 180);
    expect(value.windows.map((window) => window.sourceChunk.kind)).toEqual([
      "block",
      "import",
      "constant",
      "function",
      "comment",
    ]);
    expect(value.windows[1]!.text).toContain("require_once");
  });
});

const SCALA_CASES = [
  ["package-class.scala", 240],
  ["modern-comments.scala", 220],
] as const;

describe("Scala source windows", () => {
  reviewCases("scala", SCALA_CASES);

  test("preserves indentation with package-owned class boundaries", async () => {
    const value = await project("scala", "package-class.scala", 240);
    expect(value.windows).toHaveLength(3);
    expect(value.windows.every((window) => window.sourceChunk.kind === "package"))
      .toBe(true);
    expect(value.windows[1]!.text).toStartWith("\n  def add");
    expect(value.windows[2]!.text).toStartWith("  def render");
  });

  test("keeps Scala 3 enums, givens, extensions, and comments", async () => {
    const value = await project("scala", "modern-comments.scala", 220);
    expect(value.windows).toHaveLength(3);
    expect(value.windows[0]!.text).toContain("enum RetryPolicy");
    expect(value.windows[1]!.text).toContain("given Ordering");
    expect(value.windows[2]!.text).toContain("extension (policy");
    expect(value.windows[2]!.text).toContain("final comment");
  });
});

const KOTLIN_CASES = [
  ["package-class.kt", 240],
  ["modern-comments.kt", 220],
] as const;

describe("Kotlin source windows", () => {
  reviewCases("kotlin", KOTLIN_CASES);

  test("uses class members as package-owned boundaries", async () => {
    const value = await project("kotlin", "package-class.kt", 240);
    expect(value.windows).toHaveLength(3);
    expect(value.windows.every((window) => window.sourceChunk.kind === "package"))
      .toBe(true);
    expect(value.windows[1]!.text).toStartWith("\n    fun add");
    expect(value.windows[2]!.text).toContain("fun render");
  });

  test("keeps sealed types, data objects, extensions, and comments", async () => {
    const value = await project("kotlin", "modern-comments.kt", 220);
    expect(value.windows).toHaveLength(2);
    expect(value.windows[0]!.text).toContain("data object None");
    expect(value.windows[1]!.text).toContain("data class Delayed");
    expect(value.windows[1]!.text).toContain("isDelayed");
    expect(value.windows[1]!.text).toContain("final comment");
  });
});

const LUA_CASES = [
  ["table-module.lua", 160],
  ["loaders-comments.lua", 160],
] as const;

describe("Lua source windows", () => {
  reviewCases("lua", LUA_CASES);

  test("keeps table methods as independent top-level parents", async () => {
    const value = await project("lua", "table-module.lua", 160);
    expect(value.windows.map((window) => window.sourceChunk.kind)).toEqual([
      "variable",
      "variable",
      "function",
      "method",
      "method",
      "method",
      "method",
      "block",
    ]);
    const renderWindows = value.windows.filter(
      (window) => window.sourceChunk.name === "ReportBook:render",
    );
    expect(renderWindows).toHaveLength(2);
    expect(new Set(renderWindows.map((window) => window.sourceChunk)).size)
      .toBe(1);
  });

  test("keeps require bindings, doc comments, and standalone comments", async () => {
    const value = await project("lua", "loaders-comments.lua", 160);
    expect(value.windows.map((window) => window.sourceChunk.kind)).toEqual([
      "variable",
      "variable",
      "function",
      "comment",
    ]);
    expect(value.windows[0]!.text).toContain('require("json")');
    expect(value.windows[2]!.text).toStartWith("--- Return");
  });
});

const ZIG_CASES = [
  ["container.zig", 240],
  ["imports-comments.zig", 160],
] as const;

describe("Zig source windows", () => {
  reviewCases("zig", ZIG_CASES);

  test("uses nested container declarations and functions as struct boundaries", async () => {
    const value = await project("zig", "container.zig", 240);
    expect(value.windows).toHaveLength(4);
    expect(value.windows.every((window) => window.sourceChunk.kind === "struct"))
      .toBe(true);
    expect(value.windows[0]!.text).toContain("const Entry = struct");
    expect(value.windows[1]!.text).toContain("pub fn render");
  });

  test("keeps imports as constants and retains documentation comments", async () => {
    const value = await project("zig", "imports-comments.zig", 160);
    expect(value.windows.map((window) => window.sourceChunk.kind)).toEqual([
      "constant",
      "constant",
      "function",
      "comment",
    ]);
    expect(value.windows[0]!.text).toContain("@import");
    expect(value.windows[2]!.text).toStartWith("/// Return");
  });
});

const ELIXIR_CASES = [
  ["module-functions.ex", 220],
  ["imports-comments.ex", 200],
] as const;

describe("Elixir source windows", () => {
  reviewCases("elixir", ELIXIR_CASES);

  test("uses module functions as non-overlapping boundaries", async () => {
    const value = await project("elixir", "module-functions.ex", 220);
    expect(value.windows).toHaveLength(3);
    expect(value.windows.every((window) => window.sourceChunk.kind === "module"))
      .toBe(true);
    expect(value.windows[0]!.text).toContain("@moduledoc");
    expect(value.windows[2]!.text).toContain("def render");
  });

  test("keeps aliases, imports, attributes, docs, and comments", async () => {
    const value = await project("elixir", "imports-comments.ex", 200);
    expect(value.windows).toHaveLength(3);
    expect(value.windows[0]!.text).toContain("alias DateTime");
    expect(value.windows[0]!.text).toContain("import Kernel");
    expect(value.windows[1]!.text).toContain("@doc");
    expect(value.windows[2]!.sourceChunk.kind).toBe("comment");
  });
});

const BASH_CASES = [
  ["functions.sh", 180],
  ["source-comments.sh", 160],
] as const;

describe("Bash source windows", () => {
  reviewCases("bash", BASH_CASES);

  test("keeps functions and script-level commands as independent parents", async () => {
    const value = await project("bash", "functions.sh", 180);
    expect(value.windows.map((window) => window.sourceChunk.kind)).toEqual([
      "comment",
      "block",
      "function",
      "function",
      "function",
      "block",
    ]);
    expect(value.windows.at(-1)!.text).toContain('main "$@"');
  });

  test("keeps the shebang with an attached source directive", async () => {
    const value = await project("bash", "source-comments.sh", 160);
    expect(value.windows.map((window) => window.sourceChunk.kind)).toEqual([
      "import",
      "constant",
      "function",
      "comment",
    ]);
    expect(value.windows[0]!.text).toStartWith("#!/usr/bin/env bash");
    expect(value.windows[0]!.text).toContain("source ");
  });
});

const HASKELL_CASES = [
  ["module-functions.hs", 180],
  ["imports-comments.hs", 160],
] as const;

describe("Haskell source windows", () => {
  reviewCases("haskell", HASKELL_CASES);

  test("keeps signatures separate while using where bindings as boundaries", async () => {
    const value = await project("haskell", "module-functions.hs", 180);
    expect(value.windows.map((window) => window.sourceChunk.kind)).toEqual([
      "module",
      "type",
      "type",
      "function",
      "function",
      "type",
      "variable",
    ]);
    const renderWindows = value.windows.filter(
      (window) => window.sourceChunk.name === "render" &&
        window.sourceChunk.kind === "function",
    );
    expect(renderWindows).toHaveLength(2);
    expect(renderWindows[1]!.text).toContain("renderEntry");
  });

  test("attaches Haddock to the signature and preserves comments", async () => {
    const value = await project("haskell", "imports-comments.hs", 160);
    expect(value.windows[2]!.sourceChunk.kind).toBe("type");
    expect(value.windows[2]!.text).toStartWith("-- | Return");
    expect(value.windows.at(-1)!.sourceChunk.kind).toBe("comment");
  });
});

const OCAML_CASES = [
  ["module-class.ml", 240],
  ["opens-comments.ml", 160],
] as const;

describe("OCaml source windows", () => {
  reviewCases("ocaml", OCAML_CASES);

  test("uses class methods as module-owned boundaries", async () => {
    const value = await project("ocaml", "module-class.ml", 240);
    expect(value.windows).toHaveLength(2);
    expect(value.windows.every((window) => window.sourceChunk.kind === "module"))
      .toBe(true);
    expect(value.windows[0]!.text).toContain("class report_book");
    expect(value.windows[1]!.text).toContain("method render");
  });

  test("keeps opens, aliases, values, docs, and comments distinct", async () => {
    const value = await project("ocaml", "opens-comments.ml", 160);
    expect(value.windows.map((window) => window.sourceChunk.kind)).toEqual([
      "import",
      "module",
      "variable",
      "function",
      "comment",
    ]);
    expect(value.windows[3]!.text).toStartWith("(** Return");
  });
});

const DART_CASES = [
  ["class-extensions.dart", 240],
  ["imports-comments.dart", 180],
] as const;

describe("Dart source windows", () => {
  reviewCases("dart", DART_CASES);

  test("uses class members as boundaries and retains extensions", async () => {
    const value = await project("dart", "class-extensions.dart", 240);
    expect(value.windows.map((window) => window.sourceChunk.kind)).toEqual([
      "class",
      "class",
      "class",
      "class",
    ]);
    const bookWindows = value.windows.filter(
      (window) => window.sourceChunk.name === "ReportBook",
    );
    expect(bookWindows).toHaveLength(2);
    expect(value.windows.at(-1)!.text).toContain("extension ReportEntryLabel");
  });

  test("keeps imports, constants, async functions, docs, and comments", async () => {
    const value = await project("dart", "imports-comments.dart", 180);
    expect(value.windows.map((window) => window.sourceChunk.kind)).toEqual([
      "import",
      "constant",
      "function",
      "function",
      "comment",
    ]);
    expect(value.windows[2]!.text).toStartWith("/// Return");
    expect(value.windows[3]!.text).toContain("async");
  });
});

const HTML_CASES = [
  ["document.html", 220],
  ["comments-assets.html", 180],
] as const;

describe("HTML source windows", () => {
  reviewCases("html", HTML_CASES);

  test("uses nested elements as boundaries under the document element", async () => {
    const value = await project("html", "document.html", 220);
    expect(value.windows[0]!.sourceChunk.kind).toBe("directive");
    const htmlWindows = value.windows.slice(1);
    expect(htmlWindows).toHaveLength(3);
    expect(htmlWindows.every((window) => window.sourceChunk.name === "html"))
      .toBe(true);
    expect(htmlWindows[1]!.text).toContain("<article");
  });

  test("attaches leading comments to elements and preserves final comments", async () => {
    const value = await project("html", "comments-assets.html", 180);
    expect(value.windows.map((window) => window.sourceChunk.kind)).toEqual([
      "directive",
      "element",
      "element",
      "comment",
    ]);
    expect(value.windows[1]!.text).toStartWith("<!-- The stylesheet");
    expect(value.windows[2]!.text).toContain("<script type=\"module\"");
  });
});

const CSS_CASES = [
  ["selectors.css", 160],
  ["at-rules-comments.css", 180],
] as const;

describe("CSS source windows", () => {
  reviewCases("css", CSS_CASES);

  test("keeps selectors as independent retrieval parents", async () => {
    const value = await project("css", "selectors.css", 160);
    expect(value.windows.every((window) => window.sourceChunk.kind === "selector"))
      .toBe(true);
    expect(value.windows.map((window) => window.sourceChunk.name)).toEqual([
      ":root",
      ".report",
      ".report__entry",
      '.report__entry[data-state="archived"]',
    ]);
  });

  test("uses nested at-rules as boundaries and preserves comments", async () => {
    const value = await project("css", "at-rules-comments.css", 180);
    expect(value.windows.map((window) => window.sourceChunk.kind)).toEqual([
      "import",
      "rule",
      "rule",
      "comment",
    ]);
    expect(value.windows[1]!.text).toStartWith("/* Responsive");
    expect(value.windows[2]!.text).toContain("@supports");
  });
});

const TOML_CASES = [
  ["config.toml", 150],
  ["array-tables.toml", 160],
] as const;

describe("TOML source windows", () => {
  reviewCases("toml", TOML_CASES);

  test("keeps root properties separate and tables as retrieval parents", async () => {
    const value = await project("toml", "config.toml", 150);
    expect(value.windows.map((window) => window.sourceChunk.kind)).toEqual([
      "property",
      "property",
      "section",
      "section",
    ]);
    expect(value.windows[2]!.text).toStartWith("# HTTP server configuration.");
    expect(value.windows[3]!.text).toContain(
      "# This final comment is intentionally standalone.",
    );
  });

  test("keeps repeated array tables as distinct source chunks", async () => {
    const value = await project("toml", "array-tables.toml", 160);
    expect(value.windows.map((window) => window.sourceChunk.name)).toEqual([
      "reports",
      "reports",
      "reports.outputs",
    ]);
    expect(value.windows[0]!.sourceChunk).not.toBe(
      value.windows[1]!.sourceChunk,
    );
  });
});

const YAML_CASES = [
  ["service.yaml", 150],
  ["anchors-comments.yaml", 150],
] as const;

describe("YAML source windows", () => {
  reviewCases("yaml", YAML_CASES);

  test("uses nested mappings and sequences as document-owned boundaries", async () => {
    const value = await project("yaml", "service.yaml", 150);
    expect(value.windows).toHaveLength(3);
    expect(value.windows.every((window) => window.sourceChunk.kind === "section"))
      .toBe(true);
    expect(new Set(value.windows.map((window) => window.sourceChunk)).size)
      .toBe(1);
    expect(value.windows[1]!.text).toContain("- path: /reports");
  });

  test("retains anchors, merge keys, block scalars, and comments", async () => {
    const value = await project("yaml", "anchors-comments.yaml", 150);
    expect(value.windows[0]!.text).toStartWith("# Shared retry policy.");
    expect(value.windows[1]!.text).toContain("<<: *defaults");
    expect(value.windows[1]!.text).toContain("command: |");
    expect(value.windows.at(-1)!.text).toContain(
      "# This final comment is intentionally standalone.",
    );
  });
});

const MARKDOWN_CASES = [
  ["guide.md", 180],
  ["fences-lists.md", 180],
] as const;

describe("Markdown source windows", () => {
  reviewCases("markdown", MARKDOWN_CASES);

  test("uses nested headings as section boundaries under one document", async () => {
    const value = await project("markdown", "guide.md", 180);
    expect(value.windows).toHaveLength(3);
    expect(value.windows.every((window) => window.sourceChunk.name === "Report Service"))
      .toBe(true);
    expect(value.windows[1]!.text).toContain("### Configuration");
    expect(value.windows[2]!.text).toStartWith("## Publishing");
  });

  test("retains fenced code, lists, and block quotes verbatim", async () => {
    const value = await project("markdown", "fences-lists.md", 180);
    expect(value.windows[0]!.text).toContain(
      "```sh\nbun test tests/source-windows.test.ts\n```",
    );
    expect(value.windows.map((window) => window.text).join("")).toContain(
      "```yaml\nreports:\n  output: ./reports",
    );
    expect(value.windows.at(-1)!.text).toContain(
      "> Keep the source available",
    );
  });
});

const TEXT_CASES = [
  ["notes.txt", 160],
  ["wrapped-paragraph.txt", 150],
] as const;

describe("plain-text source windows", () => {
  reviewCases("text", TEXT_CASES);

  test("keeps separated paragraphs as independent retrieval parents", async () => {
    const value = await project("text", "notes.txt", 160);
    expect(value.windows).toHaveLength(3);
    expect(value.windows.every((window) => window.sourceChunk.kind === "paragraph"))
      .toBe(true);
    expect(new Set(value.windows.map((window) => window.sourceChunk)).size)
      .toBe(3);
  });

  test("splits an oversized paragraph only at whole-line boundaries", async () => {
    const value = await project("text", "wrapped-paragraph.txt", 150);
    const paragraphWindows = value.windows.slice(0, 3);
    expect(new Set(paragraphWindows.map((window) => window.sourceChunk)).size)
      .toBe(1);
    expect(paragraphWindows.every((window) => window.text.endsWith("\n")))
      .toBe(true);
    expect(value.windows.at(-1)!.text).toBe(
      "A short final paragraph stays independent.\n",
    );
  });
});

const TYPESCRIPT_VARIANT_CASES = [
  ["component.tsx", 220],
  ["esm-module.mts", 180],
  ["commonjs.cts", 180],
  ["declarations.d.ts", 200],
] as const;

describe("TypeScript source-window variants", () => {
  reviewCases("typescript", TYPESCRIPT_VARIANT_CASES);

  test("keeps TSX expressions inside their owning component function", async () => {
    const value = await project("typescript", "component.tsx", 220);
    const component = value.windows.slice(2);
    expect(component).toHaveLength(2);
    expect(component.every((window) => window.sourceChunk.name === "ReportList"))
      .toBe(true);
    expect(component.at(-1)!.text).toContain("onClick={() => onSelect(report)}");
  });

  test("retains distinct ESM and CommonJS module structures", async () => {
    const esm = await project("typescript", "esm-module.mts", 180);
    const commonjs = await project("typescript", "commonjs.cts", 180);
    expect(esm.windows.map((window) => window.sourceChunk.kind)).toContain("type");
    expect(commonjs.windows.at(-1)!.sourceChunk.kind).toBe("block");
    expect(commonjs.windows.at(-1)!.text).toContain("export = reportFiles");
  });

  test("keeps declaration-only signatures as meaningful parents", async () => {
    const value = await project("typescript", "declarations.d.ts", 200);
    expect(value.windows.map((window) => window.sourceChunk.kind)).toEqual([
      "interface",
      "class",
      "function",
      "module",
    ]);
    expect(value.windows[2]!.text).toContain("declare function formatReport");
  });
});

const JAVASCRIPT_VARIANT_CASES = [
  ["component.jsx", 180],
  ["esm-module.mjs", 180],
  ["commonjs.cjs", 180],
] as const;

describe("JavaScript source-window variants", () => {
  reviewCases("javascript", JAVASCRIPT_VARIANT_CASES);

  test("keeps JSX markup and expression callbacks with the component", async () => {
    const value = await project("javascript", "component.jsx", 180);
    expect(value.windows.slice(1).every(
      (window) => window.sourceChunk.name === "ReportCard",
    )).toBe(true);
    expect(value.windows.at(-1)!.text).toContain("onOpen(report.id)");
  });

  test("retains ESM exports and CommonJS assignment blocks", async () => {
    const esm = await project("javascript", "esm-module.mjs", 180);
    const commonjs = await project("javascript", "commonjs.cjs", 180);
    expect(esm.windows.at(-1)!.text).toContain("export default loadReport");
    expect(commonjs.windows.at(-1)!.sourceChunk.kind).toBe("block");
    expect(commonjs.windows.at(-1)!.text).toContain("module.exports");
  });
});

describe("Python stub source windows", () => {
  reviewCases("python", [["stubs.pyi", 200]]);

  test("keeps stub declarations and overloads without implementations", async () => {
    const value = await project("python", "stubs.pyi", 200);
    expect(value.windows.filter(
      (window) => window.sourceChunk.name === "format_report",
    )).toHaveLength(2);
    expect(value.windows.at(-1)!.text).toContain("-> None: ...");
  });
});

describe("script and interface source-window variants", () => {
  reviewCases("scala", [["report.sc", 180]]);
  reviewCases("kotlin", [["report.kts", 180]]);
  reviewCases("elixir", [["report.exs", 180]]);
  reviewCases("bash", [["report.bash", 170]]);
  reviewCases("ocaml", [["report.mli", 180]]);

  test("keeps Scala and Kotlin script statements as meaningful blocks", async () => {
    const scala = await project("scala", "report.sc", 180);
    const kotlin = await project("kotlin", "report.kts", 180);
    expect(scala.windows.at(-1)!.sourceChunk.kind).toBe("block");
    expect(kotlin.windows.at(-1)!.sourceChunk.kind).toBe("block");
    expect(scala.windows.at(-1)!.text).toContain("println");
    expect(kotlin.windows.at(-1)!.text).toContain("println");
  });

  test("keeps Elixir script execution outside its module owner", async () => {
    const value = await project("elixir", "report.exs", 180);
    expect(value.windows.map((window) => window.sourceChunk.kind)).toEqual([
      "import",
      "module",
      "block",
    ]);
    expect(value.windows.at(-1)!.text).toContain("ReportScript.load");
  });

  test("retains Bash shebangs, sourced files, functions, and execution", async () => {
    const value = await project("bash", "report.bash", 170);
    expect(value.windows.map((window) => window.sourceChunk.kind)).toEqual([
      "comment",
      "import",
      "function",
      "constant",
      "block",
    ]);
  });

  test("keeps OCaml interface declarations as named source parents", async () => {
    const value = await project("ocaml", "report.mli", 180);
    expect(value.windows.map((window) => window.sourceChunk.kind)).toEqual([
      "type",
      "module",
      "class",
      "function",
    ]);
    expect(value.windows.at(-1)!.text).toStartWith("val format_report");
  });
});

describe("C and C++ extension variants", () => {
  reviewCases("c", [["report.h", 180]]);
  reviewCases("cpp", [
    ["implementation.cc", 170],
    ["format.cxx", 180],
    ["declarations.hpp", 180],
    ["status.hh", 180],
  ]);

  test("keeps a C include guard as the header retrieval owner", async () => {
    const value = await project("c", "report.h", 180);
    expect(value.windows).toHaveLength(2);
    expect(value.windows.every(
      (window) => window.sourceChunk.kind === "conditional",
    )).toBe(true);
    expect(value.windows[0]!.text).toContain("typedef struct");
    expect(value.windows[1]!.text).toContain("#endif");
  });

  test("reviews every alternate C++ source and header extension", async () => {
    const implementation = await project("cpp", "implementation.cc", 170);
    const template = await project("cpp", "format.cxx", 180);
    const declarations = await project("cpp", "declarations.hpp", 180);
    const guarded = await project("cpp", "status.hh", 180);
    expect(implementation.windows.some(
      (window) => window.sourceChunk.kind === "module",
    )).toBe(true);
    expect(template.windows.some(
      (window) => window.sourceChunk.kind === "function",
    )).toBe(true);
    expect(declarations.windows[0]!.sourceChunk.kind).toBe("directive");
    expect(guarded.windows.every(
      (window) => window.sourceChunk.kind === "conditional",
    )).toBe(true);
  });
});

describe("document extension variants", () => {
  reviewCases("html", [["report.htm", 180]]);
  reviewCases("yaml", [["documents.yml", 130]]);
  reviewCases("markdown", [["setext.markdown", 160]]);

  test("keeps .htm nested elements under its document element", async () => {
    const value = await project("html", "report.htm", 180);
    expect(value.windows.slice(1).every(
      (window) => window.sourceChunk.name === "html",
    )).toBe(true);
    expect(value.windows[2]!.text).toContain("<main>");
  });

  test("keeps separate YAML documents as separate owners", async () => {
    const value = await project("yaml", "documents.yml", 130);
    expect(value.windows).toHaveLength(2);
    expect(value.windows[0]!.sourceChunk).not.toBe(value.windows[1]!.sourceChunk);
    expect(value.windows.every((window) => window.text.startsWith("---")))
      .toBe(true);
  });

  test("recognizes Setext sections through .markdown", async () => {
    const value = await project("markdown", "setext.markdown", 160);
    expect(value.windows.every(
      (window) => window.sourceChunk.name === "Report format",
    )).toBe(true);
    expect(value.windows[1]!.text).toStartWith("Output\n------");
  });
});

describe("plain-text fallback source-window variants", () => {
  reviewCases("text", [
    ["events.log", 120],
    ["README", 160],
    ["report.notes", 120],
  ]);

  test("reviews known, extensionless, and unknown text paths", async () => {
    const log = await project("text", "events.log", 120);
    const extensionless = await project("text", "README", 160);
    const unknown = await project("text", "report.notes", 120);
    expect(log.windows).toHaveLength(2);
    expect(extensionless.windows).toHaveLength(2);
    expect(unknown.windows).toHaveLength(2);
    expect([...log.windows, ...extensionless.windows, ...unknown.windows].every(
      (window) => window.sourceChunk.kind === "paragraph",
    )).toBe(true);
  });
});

describe("reviewed source-window frontier", () => {
  test("has fixture evidence for every chunker extension", async () => {
    const fixturePaths = await Array.fromAsync(
      new Bun.Glob("*/*").scan({ cwd: FIXTURES, onlyFiles: true }),
    );
    const fixtureExtensions = new Set(
      fixturePaths.map((path) => extname(path).toLowerCase()),
    );

    for (const extension of Object.keys(EXTENSION_MAP)) {
      expect(fixtureExtensions.has(extension)).toBe(true);
    }
    expect(fixturePaths.some((path) => path.endsWith(".d.ts"))).toBe(true);
    expect(fixtureExtensions.has(".markdown")).toBe(true);
    expect(fixtureExtensions.has(".log")).toBe(true);
    expect(fixturePaths.some((path) => extname(path) === "")).toBe(true);
  });

  test("keeps a human-reviewable golden beside every fixture", async () => {
    const fixturePaths = await Array.fromAsync(
      new Bun.Glob("*/*").scan({ cwd: FIXTURES, onlyFiles: true }),
    );

    expect([...REVIEWED_CASE_PATHS].sort()).toEqual(fixturePaths.sort());

    for (const fixturePath of fixturePaths) {
      const [language, name] = fixturePath.split("/");
      expect(language).toBeDefined();
      expect(name).toBeDefined();
      expect(
        await Bun.file(
          join(GOLDENS, language!, sourceWindowGoldenName(name!)),
        ).exists(),
      ).toBe(true);
    }
  });
});
