import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { extname, join } from "node:path";

import {
  chunk,
  SOURCE_FACT_EXTENSIONS,
  SOURCE_RELATIONSHIP_EXTENSIONS,
} from "@winci/bun-chunk";
import { renderSourceRelationships } from "../src/cli/renderers/source-relationships.ts";
import {
  connectSourceFiles,
  parseGoModulePath,
  type AnalyzedSourceFile,
  type SourceRelationshipOptions,
} from "../src/internals/source/relationships.ts";

const SUITES = [
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
  "markdown",
  "toml",
  "yaml",
  "text",
  "mixed",
] as const;
const ABSENCE_SUITES = new Set<string>(["toml", "yaml"]);
for (const suite of SUITES) {
  const projects = join(import.meta.dir, "fixtures", "projects", suite);
  const goldens = join(import.meta.dir, "goldens", "relationships", suite);
  const projectNames = readdirSync(projects, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  describe(`${suite} source relationships`, () => {
    for (const projectName of projectNames) {
      test(projectName, async () => {
        const root = join(projects, projectName);
        const paths = [...new Bun.Glob("**/*").scanSync({ cwd: root, onlyFiles: true })]
          .filter((path) =>
            suite === "text" ||
            (ABSENCE_SUITES.has(suite)
              ? SOURCE_FACT_EXTENSIONS
              : SOURCE_RELATIONSHIP_EXTENSIONS).has(extname(path))
          )
          .sort();
        const files: AnalyzedSourceFile[] = [];
        for (const path of paths) {
          files.push({
            path,
            result: await chunk(path, await Bun.file(join(root, path)).text()),
          });
        }

        const options: SourceRelationshipOptions = {};
        options.projectPaths = new Set(
          new Bun.Glob("**/*").scanSync({ cwd: root, onlyFiles: true }),
        );
        if (suite === "go") {
          const goMod = Bun.file(join(root, "go.mod"));
          options.goModulePath = await goMod.exists()
            ? parseGoModulePath(await goMod.text())
            : null;
        }
        const relationships = connectSourceFiles(files, options);
        const expected = await Bun.file(join(goldens, `${projectName}.txt`)).text();
        expect(renderSourceRelationships(`${suite}/${projectName}`, relationships))
          .toBe(expected.trimEnd());
      });
    }
  });
}

describe("relationship project metadata", () => {
  test("parses plain and quoted Go module directives", () => {
    expect(parseGoModulePath("module example.com/plain\n\ngo 1.24\n"))
      .toBe("example.com/plain");
    expect(parseGoModulePath("// generated\nmodule \"example.com/quoted\"\n"))
      .toBe("example.com/quoted");
    expect(parseGoModulePath("module `example.com/raw`\n"))
      .toBe("example.com/raw");
    expect(parseGoModulePath("go 1.24\n")).toBeNull();
  });
});
