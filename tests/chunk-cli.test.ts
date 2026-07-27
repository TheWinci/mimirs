import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { EXTENSION_MAP } from "@winci/bun-chunk";

import { REVIEWED_SOURCE_WINDOW_LANGUAGE_BY_EXTENSION } from "../src/cli/commands/chunk.ts";

const ROOT = join(import.meta.dir, "..");
const CLI = join(ROOT, "src", "cli", "index.ts");
const FIXTURE = "tests/fixtures/typescript/blocks.ts";
const SOURCE_WINDOW_FIXTURE =
  "tests/fixtures/source-windows/typescript/nested-class.ts";
const JAVASCRIPT_SOURCE_WINDOW_FIXTURE =
  "tests/fixtures/source-windows/javascript/oversized-class.js";
const PYTHON_SOURCE_WINDOW_FIXTURE =
  "tests/fixtures/source-windows/python/nested-function.py";
const GO_SOURCE_WINDOW_FIXTURE =
  "tests/fixtures/source-windows/go/oversized-function.go";
const BATCH_ONE_SOURCE_WINDOW_CASES = [
  ["rust", "impl-and-functions.rs", "230"],
  ["java", "nested-class.java", "260"],
  ["c", "preprocessor-comments.c", "200"],
  ["cpp", "namespace-class.cpp", "260"],
  ["csharp", "modern-types-comments.cs", "200"],
] as const;
const BATCH_TWO_SOURCE_WINDOW_CASES = [
  ["ruby", "module-class.rb", "220"],
  ["php", "namespace-class.php", "280"],
  ["scala", "package-class.scala", "240"],
  ["kotlin", "package-class.kt", "240"],
  ["lua", "table-module.lua", "160"],
] as const;
const BATCH_THREE_SOURCE_WINDOW_CASES = [
  ["zig", "container.zig", "240"],
  ["elixir", "module-functions.ex", "220"],
  ["bash", "functions.sh", "180"],
  ["haskell", "module-functions.hs", "180"],
  ["ocaml", "module-class.ml", "240"],
  ["dart", "class-extensions.dart", "240"],
] as const;
const BATCH_FOUR_SOURCE_WINDOW_CASES = [
  ["html", "document.html", "220"],
  ["css", "at-rules-comments.css", "180"],
  ["toml", "config.toml", "150"],
  ["yaml", "anchors-comments.yaml", "150"],
  ["markdown", "fences-lists.md", "180"],
  ["text", "wrapped-paragraph.txt", "150"],
] as const;
const BATCH_FIVE_SOURCE_WINDOW_CASES = [
  ["typescript", "component.tsx", "220"],
  ["typescript", "esm-module.mts", "180"],
  ["typescript", "commonjs.cts", "180"],
  ["typescript", "declarations.d.ts", "200"],
  ["javascript", "component.jsx", "180"],
  ["javascript", "esm-module.mjs", "180"],
  ["javascript", "commonjs.cjs", "180"],
  ["python", "stubs.pyi", "200"],
  ["scala", "report.sc", "180"],
  ["kotlin", "report.kts", "180"],
  ["elixir", "report.exs", "180"],
  ["bash", "report.bash", "170"],
  ["ocaml", "report.mli", "180"],
  ["c", "report.h", "180"],
  ["cpp", "implementation.cc", "170"],
  ["cpp", "format.cxx", "180"],
  ["cpp", "declarations.hpp", "180"],
  ["cpp", "status.hh", "180"],
  ["html", "report.htm", "180"],
  ["yaml", "documents.yml", "130"],
  ["markdown", "setext.markdown", "160"],
  ["text", "events.log", "120"],
  ["text", "README", "160"],
  ["text", "report.notes", "120"],
] as const;
const JAVASCRIPT_FIXTURE = "tests/fixtures/javascript/modules.js";
const PYTHON_FIXTURE = "tests/fixtures/python/imports.py";
const GO_FIXTURE = "tests/fixtures/go/imports.go";
const RUST_FIXTURE = "tests/fixtures/rust/imports.rs";
const JAVA_FIXTURE = "tests/fixtures/java/imports.java";
const C_FIXTURE = "tests/fixtures/c/includes.c";
const CPP_FIXTURE = "tests/fixtures/cpp/preprocessor.cpp";
const CSHARP_FIXTURE = "tests/fixtures/csharp/imports.cs";
const RUBY_FIXTURE = "tests/fixtures/ruby/imports.rb";
const PHP_FIXTURE = "tests/fixtures/php/imports.php";
const SCALA_FIXTURE = "tests/fixtures/scala/imports.scala";
const KOTLIN_FIXTURE = "tests/fixtures/kotlin/imports.kt";
const LUA_FIXTURE = "tests/fixtures/lua/modules.lua";
const ZIG_FIXTURE = "tests/fixtures/zig/imports.zig";
const ELIXIR_FIXTURE = "tests/fixtures/elixir/imports.ex";
const BASH_FIXTURE = "tests/fixtures/bash/imports.sh";
const HASKELL_FIXTURE = "tests/fixtures/haskell/imports.hs";
const OCAML_FIXTURE = "tests/fixtures/ocaml/modules.ml";
const DART_FIXTURE = "tests/fixtures/dart/modules.dart";
const HTML_FIXTURE = "tests/fixtures/html/document.html";
const CSS_FIXTURE = "tests/fixtures/css/imports.css";
const TOML_FIXTURE = "tests/fixtures/toml/semantic-traps.toml";
const YAML_FIXTURE = "tests/fixtures/yaml/semantic-traps.yaml";
const MARKDOWN_FIXTURE = "tests/fixtures/markdown/links.md";
const TEXT_FIXTURE = "tests/fixtures/text/semantic-traps.txt";
const PROJECT_FIXTURE = "tests/fixtures/projects/mixed/basic";
const ALL_LANGUAGES_PROJECT_FIXTURE = "tests/fixtures/project-discovery";

async function runCli(...args: string[]) {
  const process = Bun.spawn(["bun", CLI, ...args], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function sourceWindowGoldenName(name: string): string {
  const firstDot = name.indexOf(".");
  return `${firstDot < 0 ? name : name.slice(0, firstDot)}.windows.txt`;
}

describe("chunk CLI", () => {
  test("prints chunk JSON", async () => {
    const result = await runCli("chunk", "-f", FIXTURE);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      file: FIXTURE,
      language: "typescript",
      strategy: "ast",
      binary: false,
    });
  });

  test("prints the reviewed tree", async () => {
    const result = await runCli("chunk", "-f", FIXTURE, "--tree");
    const golden = await Bun.file(
      join(ROOT, "tests", "goldens", "typescript", "blocks.tree.txt"),
    ).text();

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trimEnd()).toBe(golden.trimEnd());
  });

  test("prints the reviewed source facts", async () => {
    const result = await runCli("chunk", "-f", FIXTURE, "--facts");
    const golden = await Bun.file(
      join(ROOT, "tests", "goldens", "source-facts", "typescript", "blocks.facts.txt"),
    ).text();

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trimEnd()).toBe(golden.trimEnd());
  });

  test("prints the reviewed source-window tree", async () => {
    const result = await runCli(
      "chunk",
      "-f",
      SOURCE_WINDOW_FIXTURE,
      "--windows",
      "--window-size",
      "180",
    );
    const golden = await Bun.file(
      join(
        ROOT,
        "tests",
        "goldens",
        "source-windows",
        "typescript",
        "nested-class.windows.txt",
      ),
    ).text();

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trimEnd()).toBe(golden.trimEnd());
  });

  test("prints reviewed JavaScript source windows", async () => {
    const result = await runCli(
      "chunk",
      "-f",
      JAVASCRIPT_SOURCE_WINDOW_FIXTURE,
      "--windows",
      "--window-size",
      "160",
    );
    const golden = await Bun.file(
      join(
        ROOT,
        "tests",
        "goldens",
        "source-windows",
        "javascript",
        "oversized-class.windows.txt",
      ),
    ).text();

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trimEnd()).toBe(golden.trimEnd());
  });

  test("prints reviewed Python source windows", async () => {
    const result = await runCli(
      "chunk",
      "-f",
      PYTHON_SOURCE_WINDOW_FIXTURE,
      "--windows",
      "--window-size",
      "220",
    );
    const golden = await Bun.file(
      join(
        ROOT,
        "tests",
        "goldens",
        "source-windows",
        "python",
        "nested-function.windows.txt",
      ),
    ).text();

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trimEnd()).toBe(golden.trimEnd());
  });

  test("prints reviewed Go source windows", async () => {
    const result = await runCli(
      "chunk",
      "-f",
      GO_SOURCE_WINDOW_FIXTURE,
      "--windows",
      "--window-size",
      "400",
    );
    const golden = await Bun.file(
      join(
        ROOT,
        "tests",
        "goldens",
        "source-windows",
        "go",
        "oversized-function.windows.txt",
      ),
    ).text();

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trimEnd()).toBe(golden.trimEnd());
  });

  test("prints reviewed Batch 1 source windows", async () => {
    for (const [language, name, windowSize] of BATCH_ONE_SOURCE_WINDOW_CASES) {
      const fixture = `tests/fixtures/source-windows/${language}/${name}`;
      const goldenName = sourceWindowGoldenName(name);
      const result = await runCli(
        "chunk",
        "-f",
        fixture,
        "--windows",
        "--window-size",
        windowSize,
      );
      const golden = await Bun.file(
        join(
          ROOT,
          "tests",
          "goldens",
          "source-windows",
          language,
          goldenName,
        ),
      ).text();

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout.trimEnd()).toBe(golden.trimEnd());
    }
  });

  test("prints reviewed Batch 2 source windows", async () => {
    for (const [language, name, windowSize] of BATCH_TWO_SOURCE_WINDOW_CASES) {
      const fixture = `tests/fixtures/source-windows/${language}/${name}`;
      const goldenName = sourceWindowGoldenName(name);
      const result = await runCli(
        "chunk",
        "-f",
        fixture,
        "--windows",
        "--window-size",
        windowSize,
      );
      const golden = await Bun.file(
        join(
          ROOT,
          "tests",
          "goldens",
          "source-windows",
          language,
          goldenName,
        ),
      ).text();

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout.trimEnd()).toBe(golden.trimEnd());
    }
  });

  test("prints reviewed Batch 3 source windows", async () => {
    for (const [language, name, windowSize] of BATCH_THREE_SOURCE_WINDOW_CASES) {
      const fixture = `tests/fixtures/source-windows/${language}/${name}`;
      const goldenName = sourceWindowGoldenName(name);
      const result = await runCli(
        "chunk",
        "-f",
        fixture,
        "--windows",
        "--window-size",
        windowSize,
      );
      const golden = await Bun.file(
        join(
          ROOT,
          "tests",
          "goldens",
          "source-windows",
          language,
          goldenName,
        ),
      ).text();

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout.trimEnd()).toBe(golden.trimEnd());
    }
  });

  test("prints reviewed Batch 4 source windows", async () => {
    for (const [language, name, windowSize] of BATCH_FOUR_SOURCE_WINDOW_CASES) {
      const fixture = `tests/fixtures/source-windows/${language}/${name}`;
      const goldenName = sourceWindowGoldenName(name);
      const result = await runCli(
        "chunk",
        "-f",
        fixture,
        "--windows",
        "--window-size",
        windowSize,
      );
      const golden = await Bun.file(
        join(
          ROOT,
          "tests",
          "goldens",
          "source-windows",
          language,
          goldenName,
        ),
      ).text();

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout.trimEnd()).toBe(golden.trimEnd());
    }
  });

  test("prints reviewed Batch 5 source-window variants", async () => {
    for (const [language, name, windowSize] of BATCH_FIVE_SOURCE_WINDOW_CASES) {
      const fixture = `tests/fixtures/source-windows/${language}/${name}`;
      const goldenName = sourceWindowGoldenName(name);
      const result = await runCli(
        "chunk",
        "-f",
        fixture,
        "--windows",
        "--window-size",
        windowSize,
      );
      const golden = await Bun.file(
        join(
          ROOT,
          "tests",
          "goldens",
          "source-windows",
          language,
          goldenName,
        ),
      ).text();

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout.trimEnd()).toBe(golden.trimEnd());
    }
  });

  test("requires source-window options to be internally consistent", async () => {
    const withoutView = await runCli(
      "chunk",
      "-f",
      SOURCE_WINDOW_FIXTURE,
      "--window-size",
      "180",
    );
    expect(withoutView.exitCode).toBe(2);
    expect(withoutView.stderr).toContain("--window-size requires --windows");

    const invalidSize = await runCli(
      "chunk",
      "-f",
      SOURCE_WINDOW_FIXTURE,
      "--windows",
      "--window-size",
      "0",
    );
    expect(invalidSize.exitCode).toBe(2);
    expect(invalidSize.stderr).toContain("positive integer");

    const multipleViews = await runCli(
      "chunk",
      "-f",
      SOURCE_WINDOW_FIXTURE,
      "--tree",
      "--windows",
    );
    expect(multipleViews.exitCode).toBe(2);
    expect(multipleViews.stderr).toContain("Choose one");
  });

  test("keeps the reviewed AST extension gate in lockstep with the chunker", () => {
    const reviewedAstExtensions = Object.fromEntries(
      [...REVIEWED_SOURCE_WINDOW_LANGUAGE_BY_EXTENSION].filter(
        ([, language]) => language !== "markdown" && language !== "text",
      ),
    );

    expect(reviewedAstExtensions).toEqual(EXTENSION_MAP);
    expect(REVIEWED_SOURCE_WINDOW_LANGUAGE_BY_EXTENSION.get(".md")).toBe(
      "markdown",
    );
    expect(REVIEWED_SOURCE_WINDOW_LANGUAGE_BY_EXTENSION.get(".markdown"))
      .toBe("markdown");
    expect(REVIEWED_SOURCE_WINDOW_LANGUAGE_BY_EXTENSION.get(".txt")).toBe(
      "text",
    );
  });

  test("prints reviewed JavaScript source facts", async () => {
    const result = await runCli("chunk", "-f", JAVASCRIPT_FIXTURE, "--facts");
    const golden = await Bun.file(
      join(ROOT, "tests", "goldens", "source-facts", "javascript", "modules.facts.txt"),
    ).text();

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trimEnd()).toBe(golden.trimEnd());
  });

  test("prints reviewed Python source facts", async () => {
    const result = await runCli("chunk", "-f", PYTHON_FIXTURE, "--facts");
    const golden = await Bun.file(
      join(ROOT, "tests", "goldens", "source-facts", "python", "imports.facts.txt"),
    ).text();

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trimEnd()).toBe(golden.trimEnd());
  });

  test("prints reviewed Go source facts", async () => {
    const result = await runCli("chunk", "-f", GO_FIXTURE, "--facts");
    const golden = await Bun.file(
      join(ROOT, "tests", "goldens", "source-facts", "go", "imports.facts.txt"),
    ).text();

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trimEnd()).toBe(golden.trimEnd());
  });

  test("prints reviewed Rust source facts", async () => {
    const result = await runCli("chunk", "-f", RUST_FIXTURE, "--facts");
    const golden = await Bun.file(
      join(ROOT, "tests", "goldens", "source-facts", "rust", "imports.facts.txt"),
    ).text();

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trimEnd()).toBe(golden.trimEnd());
  });

  test("prints reviewed Java source facts", async () => {
    const result = await runCli("chunk", "-f", JAVA_FIXTURE, "--facts");
    const golden = await Bun.file(
      join(ROOT, "tests", "goldens", "source-facts", "java", "imports.facts.txt"),
    ).text();

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trimEnd()).toBe(golden.trimEnd());
  });

  test("prints reviewed C source facts", async () => {
    const result = await runCli("chunk", "-f", C_FIXTURE, "--facts");
    const golden = await Bun.file(
      join(ROOT, "tests", "goldens", "source-facts", "c", "includes.facts.txt"),
    ).text();

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trimEnd()).toBe(golden.trimEnd());
  });

  test("prints reviewed C++ source facts", async () => {
    const result = await runCli("chunk", "-f", CPP_FIXTURE, "--facts");
    const golden = await Bun.file(
      join(
        ROOT,
        "tests",
        "goldens",
        "source-facts",
        "cpp",
        "preprocessor.facts.txt",
      ),
    ).text();

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trimEnd()).toBe(golden.trimEnd());
  });

  test("prints reviewed C# source facts", async () => {
    const result = await runCli("chunk", "-f", CSHARP_FIXTURE, "--facts");
    const golden = await Bun.file(
      join(ROOT, "tests", "goldens", "source-facts", "csharp", "imports.facts.txt"),
    ).text();

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trimEnd()).toBe(golden.trimEnd());
  });

  test("prints reviewed Ruby source facts", async () => {
    const result = await runCli("chunk", "-f", RUBY_FIXTURE, "--facts");
    const golden = await Bun.file(
      join(ROOT, "tests", "goldens", "source-facts", "ruby", "imports.facts.txt"),
    ).text();

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trimEnd()).toBe(golden.trimEnd());
  });

  test("prints reviewed PHP source facts", async () => {
    const result = await runCli("chunk", "-f", PHP_FIXTURE, "--facts");
    const golden = await Bun.file(
      join(ROOT, "tests", "goldens", "source-facts", "php", "imports.facts.txt"),
    ).text();

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trimEnd()).toBe(golden.trimEnd());
  });

  test("prints reviewed Scala source facts", async () => {
    const result = await runCli("chunk", "-f", SCALA_FIXTURE, "--facts");
    const golden = await Bun.file(
      join(ROOT, "tests", "goldens", "source-facts", "scala", "imports.facts.txt"),
    ).text();

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trimEnd()).toBe(golden.trimEnd());
  });

  test("prints reviewed Kotlin source facts", async () => {
    const result = await runCli("chunk", "-f", KOTLIN_FIXTURE, "--facts");
    const golden = await Bun.file(
      join(ROOT, "tests", "goldens", "source-facts", "kotlin", "imports.facts.txt"),
    ).text();

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trimEnd()).toBe(golden.trimEnd());
  });

  test("prints reviewed Lua source facts", async () => {
    const result = await runCli("chunk", "-f", LUA_FIXTURE, "--facts");
    const golden = await Bun.file(
      join(ROOT, "tests", "goldens", "source-facts", "lua", "modules.facts.txt"),
    ).text();

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trimEnd()).toBe(golden.trimEnd());
  });

  test("prints reviewed Zig source facts", async () => {
    const result = await runCli("chunk", "-f", ZIG_FIXTURE, "--facts");
    const golden = await Bun.file(
      join(ROOT, "tests", "goldens", "source-facts", "zig", "imports.facts.txt"),
    ).text();

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trimEnd()).toBe(golden.trimEnd());
  });

  test("prints reviewed Elixir source facts", async () => {
    const result = await runCli("chunk", "-f", ELIXIR_FIXTURE, "--facts");
    const golden = await Bun.file(
      join(ROOT, "tests", "goldens", "source-facts", "elixir", "imports.facts.txt"),
    ).text();

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trimEnd()).toBe(golden.trimEnd());
  });

  test("prints reviewed Bash source facts", async () => {
    const result = await runCli("chunk", "-f", BASH_FIXTURE, "--facts");
    const golden = await Bun.file(
      join(ROOT, "tests", "goldens", "source-facts", "bash", "imports.facts.txt"),
    ).text();

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trimEnd()).toBe(golden.trimEnd());
  });

  test("prints reviewed Haskell source facts", async () => {
    const result = await runCli("chunk", "-f", HASKELL_FIXTURE, "--facts");
    const golden = await Bun.file(
      join(ROOT, "tests", "goldens", "source-facts", "haskell", "imports.facts.txt"),
    ).text();

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trimEnd()).toBe(golden.trimEnd());
  });

  test("prints reviewed OCaml source facts", async () => {
    const result = await runCli("chunk", "-f", OCAML_FIXTURE, "--facts");
    const golden = await Bun.file(
      join(ROOT, "tests", "goldens", "source-facts", "ocaml", "modules.facts.txt"),
    ).text();

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trimEnd()).toBe(golden.trimEnd());
  });

  test("prints reviewed Dart source facts", async () => {
    const result = await runCli("chunk", "-f", DART_FIXTURE, "--facts");
    const golden = await Bun.file(
      join(ROOT, "tests", "goldens", "source-facts", "dart", "modules.facts.txt"),
    ).text();

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trimEnd()).toBe(golden.trimEnd());
  });

  test("prints reviewed HTML source facts", async () => {
    const result = await runCli("chunk", "-f", HTML_FIXTURE, "--facts");
    const golden = await Bun.file(
      join(ROOT, "tests", "goldens", "source-facts", "html", "document.facts.txt"),
    ).text();

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trimEnd()).toBe(golden.trimEnd());
  });

  test("prints reviewed CSS source facts", async () => {
    const result = await runCli("chunk", "-f", CSS_FIXTURE, "--facts");
    const golden = await Bun.file(
      join(ROOT, "tests", "goldens", "source-facts", "css", "imports.facts.txt"),
    ).text();

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trimEnd()).toBe(golden.trimEnd());
  });

  test("prints the reviewed absence of TOML source facts", async () => {
    const result = await runCli("chunk", "-f", TOML_FIXTURE, "--facts");
    const golden = await Bun.file(
      join(
        ROOT,
        "tests",
        "goldens",
        "source-facts",
        "toml",
        "semantic-traps.facts.txt",
      ),
    ).text();

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trimEnd()).toBe(golden.trimEnd());
  });

  test("prints the reviewed absence of YAML source facts", async () => {
    const result = await runCli("chunk", "-f", YAML_FIXTURE, "--facts");
    const golden = await Bun.file(
      join(
        ROOT,
        "tests",
        "goldens",
        "source-facts",
        "yaml",
        "semantic-traps.facts.txt",
      ),
    ).text();

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trimEnd()).toBe(golden.trimEnd());
  });

  test("prints reviewed Markdown source facts", async () => {
    const result = await runCli("chunk", "-f", MARKDOWN_FIXTURE, "--facts");
    const golden = await Bun.file(
      join(ROOT, "tests", "goldens", "source-facts", "markdown", "links.facts.txt"),
    ).text();

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trimEnd()).toBe(golden.trimEnd());
  });

  test("prints the reviewed absence of plain-text source facts", async () => {
    const result = await runCli("chunk", "-f", TEXT_FIXTURE, "--facts");
    const golden = await Bun.file(
      join(
        ROOT,
        "tests",
        "goldens",
        "source-facts",
        "text",
        "semantic-traps.facts.txt",
      ),
    ).text();

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trimEnd()).toBe(golden.trimEnd());
  });

  test("reports a missing file", async () => {
    const result = await runCli("chunk", "-f", "tests/fixtures/typescript/missing.ts");

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("no such file");
  });
});

describe("analyze CLI", () => {
  test("prints the reviewed project analysis", async () => {
    const result = await runCli("analyze", PROJECT_FIXTURE);
    const golden = await Bun.file(
      join(ROOT, "tests", "goldens", "project-analysis", "mixed-basic.txt"),
    ).text();

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trimEnd()).toBe(
      golden.replace("mixed/basic", PROJECT_FIXTURE).trimEnd(),
    );
  });

  test("prints the reviewed all-language project analysis", async () => {
    const result = await runCli("analyze", ALL_LANGUAGES_PROJECT_FIXTURE);
    const golden = await Bun.file(
      join(ROOT, "tests", "goldens", "project-analysis", "all-languages.txt"),
    ).text();

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trimEnd()).toBe(
      golden.replace("all-languages", ALL_LANGUAGES_PROJECT_FIXTURE).trimEnd(),
    );
  });

  test("reports a missing project directory", async () => {
    const result = await runCli("analyze", "tests/fixtures/projects/missing");

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("no such project directory");
  });
});
