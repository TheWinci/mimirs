import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { chunk, type SourceChunk, type SourceFact } from "@winci/bun-chunk";
import { renderChunkTree } from "../src/cli/renderers/chunk-tree.ts";
import { renderSourceFacts } from "../src/cli/renderers/source-facts.ts";

const LANGUAGES = [
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
] as const;

function goldenName(fixtureName: string): string {
  return fixtureName.replace(
    /(?:\.d)?\.(?:ts|mts|cts|tsx|js|mjs|cjs|jsx|pyi?|go|rs|java|c|h|cpp|hpp|cs|rb|php|scala|sc|kt|kts|lua|zig|ex|exs|sh|bash|hs|mli?|dart|html?|htm|css|toml|ya?ml|md|markdown|txt|log)$/,
    ".tree.txt",
  );
}

function factGoldenName(fixtureName: string): string {
  return fixtureName.replace(
    /(?:\.d)?\.(?:ts|mts|cts|tsx|js|mjs|cjs|jsx|pyi?|go|rs|java|c|h|cpp|hpp|cs|rb|php|scala|sc|kt|kts|lua|zig|ex|exs|sh|bash|hs|mli?|dart|html?|htm|css|toml|ya?ml|md|markdown|txt|log)$/,
    ".facts.txt",
  );
}

function leaves(chunks: SourceChunk[]): SourceChunk[] {
  const result: SourceChunk[] = [];
  for (const current of chunks) {
    if (current.children.length === 0) result.push(current);
    else result.push(...leaves(current.children));
  }
  return result;
}

function expectValidTree(chunks: SourceChunk[], source: string, parent?: SourceChunk): void {
  let previousEnd = parent?.startOffset ?? 0;

  for (const current of chunks) {
    if (parent) {
      expect(current.startOffset).toBeGreaterThanOrEqual(parent.startOffset);
      expect(current.endOffset).toBeLessThanOrEqual(parent.endOffset);
    }
    expect(current.startOffset).toBeGreaterThanOrEqual(previousEnd);
    expect(current.endOffset).toBeGreaterThan(current.startOffset);

    if (current.children.length === 0) {
      expect(current.text).toBe(source.slice(current.startOffset, current.endOffset));
      if (current.kind === "gap") expect(current.text?.trim()).toBe("");
      if (current.kind === "block") expect(current.text?.trim()).not.toBe("");
    } else {
      expectValidTree(current.children, source, current);
    }

    previousEnd = current.endOffset;
  }

  expect(previousEnd).toBe(parent?.endOffset ?? source.length);
}

function expectValidFacts(facts: SourceFact[], source: string): void {
  let previousStart = 0;
  for (const fact of facts) {
    expect(fact.startOffset).toBeGreaterThanOrEqual(previousStart);
    expect(fact.endOffset).toBeGreaterThan(fact.startOffset);
    expect(fact.endOffset).toBeLessThanOrEqual(source.length);
    expect(fact.startLine).toBeGreaterThan(0);
    expect(fact.endLine).toBeGreaterThanOrEqual(fact.startLine);
    expect(source.slice(fact.startOffset, fact.endOffset)).not.toBe("");
    if (fact.owner) {
      expect(fact.startOffset).toBeGreaterThanOrEqual(fact.owner.startOffset);
      expect(fact.endOffset).toBeLessThanOrEqual(fact.owner.endOffset);
    }
    previousStart = fact.startOffset;
  }
}

for (const language of LANGUAGES) {
  const fixtures = join(import.meta.dir, "fixtures", language);
  const goldens = join(import.meta.dir, "goldens", language);
  const factGoldens = join(import.meta.dir, "goldens", "source-facts", language);
  const fixtureNames = readdirSync(fixtures)
    .filter((name) => language === "typescript"
      ? name.endsWith(".ts") && !name.endsWith(".tsx")
        || name.endsWith(".mts")
        || name.endsWith(".cts")
        || name.endsWith(".tsx")
      : language === "javascript"
      ? name.endsWith(".js") && !name.endsWith(".jsx") ||
        name.endsWith(".mjs") ||
        name.endsWith(".cjs") ||
        name.endsWith(".jsx")
      : language === "python"
      ? name.endsWith(".py") || name.endsWith(".pyi")
      : language === "go"
      ? name.endsWith(".go")
      : language === "rust"
      ? name.endsWith(".rs")
      : language === "java"
      ? name.endsWith(".java")
      : language === "c"
      ? name.endsWith(".c") || name.endsWith(".h")
      : language === "csharp"
      ? name.endsWith(".cs")
      : language === "ruby"
      ? name.endsWith(".rb")
      : language === "php"
      ? name.endsWith(".php")
      : language === "scala"
      ? name.endsWith(".scala") || name.endsWith(".sc")
      : language === "kotlin"
      ? name.endsWith(".kt") || name.endsWith(".kts")
      : language === "lua"
      ? name.endsWith(".lua")
      : language === "zig"
      ? name.endsWith(".zig")
      : language === "elixir"
      ? name.endsWith(".ex") || name.endsWith(".exs")
      : language === "bash"
      ? name.endsWith(".sh") || name.endsWith(".bash")
      : language === "haskell"
      ? name.endsWith(".hs")
      : language === "ocaml"
      ? name.endsWith(".ml") || name.endsWith(".mli")
      : language === "dart"
      ? name.endsWith(".dart")
      : language === "html"
      ? name.endsWith(".html") || name.endsWith(".htm")
      : language === "css"
      ? name.endsWith(".css")
      : language === "toml"
      ? name.endsWith(".toml")
      : language === "yaml"
      ? name.endsWith(".yaml") || name.endsWith(".yml")
      : language === "markdown"
      ? name.endsWith(".md") || name.endsWith(".markdown")
      : language === "text"
      ? name.endsWith(".txt") || name.endsWith(".log")
      : name.endsWith(".cpp") || name.endsWith(".hpp"))
    .sort();

  describe(`${language} chunker fixtures`, () => {
    for (const fixtureName of fixtureNames) {
      test(fixtureName, async () => {
        const relativePath = `tests/fixtures/${language}/${fixtureName}`;
        const path = join(fixtures, fixtureName);
        const source = await Bun.file(path).text();
        const result = await chunk(relativePath, source);
        expect(result.language).toBe(language);

        const expectedTree = await Bun.file(join(goldens, goldenName(fixtureName))).text();
        expect(renderChunkTree(relativePath, result.chunks)).toBe(expectedTree.trimEnd());
        const expectedFacts = await Bun.file(
          join(factGoldens, factGoldenName(fixtureName)),
        ).text();
        expect(renderSourceFacts(relativePath, result.facts)).toBe(expectedFacts.trimEnd());

        expectValidTree(result.chunks, source);
        expectValidFacts(result.facts, source);
        expect(leaves(result.chunks).map((leaf) => leaf.text ?? "").join("")).toBe(source);
        expect(await chunk(relativePath, source)).toEqual(result);
      });
    }
  });
}
