import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  analyzeProject,
  discoverProjectFiles,
  discoverProjectPaths,
  ProjectDirectoryNotFoundError,
} from "../src/internals/project/analysis.ts";
import { renderProjectAnalysis } from "../src/cli/renderers/project-analysis.ts";
import { SOURCE_RELATIONSHIP_EXTENSIONS } from "@winci/bun-chunk";

const DISCOVERY_FIXTURE = join(import.meta.dir, "fixtures", "project-discovery");
const MIXED_FIXTURE = join(import.meta.dir, "fixtures", "projects", "mixed", "basic");
const PROJECT_ANALYSIS_FIXTURES = join(
  import.meta.dir,
  "fixtures",
  "projects",
  "project-analysis",
);

async function expectProjectGolden(project: string): Promise<void> {
  const analysis = await analyzeProject(join(PROJECT_ANALYSIS_FIXTURES, project));
  const golden = await Bun.file(
    join(import.meta.dir, "goldens", "project-analysis", `${project}.txt`),
  ).text();
  expect(renderProjectAnalysis(project, analysis)).toBe(golden.trimEnd());
}

describe("project analysis", () => {
  test("discovers every reviewed extension and UTF-8 text fallbacks", async () => {
    const paths = await discoverProjectFiles(DISCOVERY_FIXTURE);
    expect(paths).toEqual([
      "README",
      "src/component.jsx",
      "src/component.tsx",
      "src/main.ts",
      "src/module.cjs",
      "src/module.cts",
      "src/module.mjs",
      "src/module.mts",
      "src/not-connected.bash",
      "src/not-connected.c",
      "src/not-connected.cc",
      "src/not-connected.cpp",
      "src/not-connected.cs",
      "src/not-connected.css",
      "src/not-connected.cxx",
      "src/not-connected.dart",
      "src/not-connected.ex",
      "src/not-connected.exs",
      "src/not-connected.go",
      "src/not-connected.h",
      "src/not-connected.hh",
      "src/not-connected.hpp",
      "src/not-connected.hs",
      "src/not-connected.htm",
      "src/not-connected.html",
      "src/not-connected.kt",
      "src/not-connected.kts",
      "src/not-connected.log",
      "src/not-connected.lua",
      "src/not-connected.markdown",
      "src/not-connected.md",
      "src/not-connected.ml",
      "src/not-connected.mli",
      "src/not-connected.php",
      "src/not-connected.py",
      "src/not-connected.pyi",
      "src/not-connected.rb",
      "src/not-connected.rs",
      "src/not-connected.sc",
      "src/not-connected.scala",
      "src/not-connected.sh",
      "src/not-connected.toml",
      "src/not-connected.txt",
      "src/not-connected.yaml",
      "src/not-connected.yml",
      "src/not-connected.zig",
      "src/NotConnected.java",
      "src/types.d.ts",
      "src/worker.js",
    ]);
    for (const extension of SOURCE_RELATIONSHIP_EXTENSIONS) {
      expect(paths.some((path) => path.endsWith(extension))).toBe(true);
    }
    expect(paths).toEqual(expect.arrayContaining([
      "README",
      "src/not-connected.log",
      "src/not-connected.txt",
    ]));
  });

  test("applies the default directory exclusions", async () => {
    const root = await mkdtemp(join(tmpdir(), "mimirs-project-discovery-"));
    try {
      await writeFile(join(root, "main.ts"), "export const main = true;\n");
      for (const directory of ["node_modules", "dist", "build", "coverage", "out"]) {
        await mkdir(join(root, directory), { recursive: true });
        await writeFile(
          join(root, directory, "ignored.ts"),
          `export const ${directory.replaceAll("-", "_")} = true;\n`,
        );
      }

      expect(await discoverProjectFiles(root)).toEqual(["main.ts"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("applies include and exclude globs while allowing useful hidden paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "mimirs-project-patterns-"));
    try {
      await mkdir(join(root, "src"), { recursive: true });
      await mkdir(join(root, "docs"), { recursive: true });
      await mkdir(join(root, ".github", "workflows"), { recursive: true });
      await writeFile(join(root, "src", "main.ts"), "export const main = true;\n");
      await writeFile(join(root, "src", "main.test.ts"), "throw new Error();\n");
      await writeFile(join(root, "docs", "readme.md"), "# Guide\n");
      await writeFile(join(root, ".github", "workflows", "ci.yml"), "name: CI\n");
      await writeFile(join(root, ".env"), "SECRET=value\n");
      const config = {
        include: ["**/*.ts", "**/*.yml"],
        exclude: ["**/*.test.ts", "**/.env"],
      };

      expect(await discoverProjectPaths(root, config)).toEqual([
        ".github/workflows/ci.yml",
        "docs/readme.md",
        "src/main.ts",
      ]);
      expect(await discoverProjectFiles(root, config)).toEqual([
        ".github/workflows/ci.yml",
        "src/main.ts",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("respects gitignore before applying config globs", async () => {
    const root = await mkdtemp(join(tmpdir(), "mimirs-project-gitignore-"));
    try {
      const process = Bun.spawn(["git", "init", "-q"], {
        cwd: root,
        stdout: "ignore",
        stderr: "pipe",
      });
      expect(await process.exited).toBe(0);
      await writeFile(join(root, ".gitignore"), "ignored.ts\n");
      await writeFile(join(root, "visible.ts"), "export const visible = true;\n");
      await writeFile(join(root, "ignored.ts"), "export const ignored = true;\n");

      expect(await discoverProjectFiles(root, {
        include: ["**/*.ts"],
        exclude: [],
      })).toEqual(["visible.ts"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not fall back to filesystem discovery for an empty Git result", async () => {
    const root = await mkdtemp(join(tmpdir(), "mimirs-project-empty-git-"));
    try {
      const process = Bun.spawn(["git", "init", "-q"], {
        cwd: root,
        stdout: "ignore",
        stderr: "pipe",
      });
      expect(await process.exited).toBe(0);
      await writeFile(join(root, ".git", "info", "exclude"), "*\n");
      await writeFile(join(root, "ignored.ts"), "export const ignored = true;\n");

      expect(await discoverProjectFiles(root, {
        include: ["**/*.ts"],
        exclude: [],
      })).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("analyzes and renders a mixed project", async () => {
    const analysis = await analyzeProject(MIXED_FIXTURE);
    const golden = await Bun.file(
      join(import.meta.dir, "goldens", "project-analysis", "mixed-basic.txt"),
    ).text();

    expect(analysis.root).toBe(resolve(MIXED_FIXTURE));
    expect(analysis.files.map((file) => file.path)).toEqual([
      "src/consumer.ts",
      "src/helper.d.ts",
      "src/helper.js",
      "src/main.js",
      "src/worker.ts",
    ]);
    expect(renderProjectAnalysis("mixed/basic", analysis)).toBe(golden.trimEnd());
  });

  test("renders every supported language and extension through project analysis", async () => {
    const analysis = await analyzeProject(DISCOVERY_FIXTURE);
    const golden = await Bun.file(
      join(import.meta.dir, "goldens", "project-analysis", "all-languages.txt"),
    ).text();

    expect(new Set(analysis.files.map((file) => file.result.language))).toEqual(
      new Set([
        "typescript",
        "javascript",
        "python",
        "go",
        "rust",
        "java",
        "c",
        "cpp",
        "csharp",
        "ruby",
        "php",
        "scala",
        "kotlin",
        "lua",
        "zig",
        "elixir",
        "bash",
        "haskell",
        "ocaml",
        "dart",
        "html",
        "css",
        "toml",
        "yaml",
        "markdown",
        "text",
      ]),
    );
    expect(renderProjectAnalysis("all-languages", analysis)).toBe(golden.trimEnd());
  });

  test("indexes binary resource targets without parsing them as source", async () => {
    const root = await mkdtemp(join(tmpdir(), "mimirs-project-resources-"));
    try {
      await writeFile(join(root, "index.html"), '<img src="hero.png">\n');
      await writeFile(
        join(root, "hero.png"),
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]),
      );
      const analysis = await analyzeProject(root, {
        include: ["**/*.html"],
        exclude: [],
      });

      expect(analysis.files.map((file) => file.path)).toEqual(["index.html"]);
      expect(analysis.relationships.imports).toEqual([
        expect.objectContaining({ fromPath: "index.html", toPath: "hero.png" }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("renders an empty project", async () => {
    await expectProjectGolden("empty");
  });

  test("renders unresolved imports, re-exports, and calls", async () => {
    await expectProjectGolden("unresolved");
  });

  test("reports a missing project directory", async () => {
    expect(analyzeProject(join(import.meta.dir, "fixtures", "missing")))
      .rejects.toBeInstanceOf(ProjectDirectoryNotFoundError);
  });
});
