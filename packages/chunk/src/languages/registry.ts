import type { Tree } from "web-tree-sitter";

import type { Language, SourceChunk, SourceFact } from "../types";
import { extractCFacts } from "./c/facts";
import { extractCppFacts } from "./cpp/facts";
import { extractCSharpFacts } from "./csharp/facts";
import { extractGoFacts } from "./go/facts";
import { extractJavaScriptFacts } from "./javascript/facts";
import { extractJavaFacts } from "./java/facts";
import { extractKotlinFacts } from "./kotlin/facts";
import { extractLuaFacts } from "./lua/facts";
import { extractZigFacts } from "./zig/facts";
import { extractElixirFacts } from "./elixir/facts";
import { extractBashFacts } from "./bash/facts";
import { extractHaskellFacts } from "./haskell/facts";
import { extractOcamlFacts } from "./ocaml/facts";
import { extractDartFacts } from "./dart/facts";
import { extractHtmlFacts } from "./html/facts";
import { extractCssFacts } from "./css/facts";
import { extractTomlFacts } from "./toml/facts";
import { extractYamlFacts } from "./yaml/facts";
import { extractPythonFacts } from "./python/facts";
import { extractPhpFacts } from "./php/facts";
import { extractRustFacts } from "./rust/facts";
import { extractRubyFacts } from "./ruby/facts";
import { extractScalaFacts } from "./scala/facts";
import { extractTypeScriptFacts } from "./typescript/facts";

type FactExtractor = (
  tree: Tree,
  chunks: SourceChunk[],
  lineStarts: number[],
) => SourceFact[];

interface FactLanguageDefinition {
  extensions: readonly string[];
  extract: FactExtractor;
  relationships: boolean;
}

export const SOURCE_FACT_LANGUAGE_EXTENSIONS = {
  typescript: [".ts", ".mts", ".cts", ".tsx", ".d.ts"],
  javascript: [".js", ".mjs", ".cjs", ".jsx"],
  python: [".py", ".pyi"],
  go: [".go"],
  rust: [".rs"],
  java: [".java"],
  c: [".c", ".h"],
  cpp: [".cpp", ".cc", ".cxx", ".hpp", ".hh"],
  csharp: [".cs"],
  ruby: [".rb"],
  php: [".php"],
  scala: [".scala", ".sc"],
  kotlin: [".kt", ".kts"],
  lua: [".lua"],
  zig: [".zig"],
  elixir: [".ex", ".exs"],
  bash: [".sh", ".bash"],
  haskell: [".hs"],
  ocaml: [".ml", ".mli"],
  dart: [".dart"],
  html: [".html", ".htm"],
  css: [".css"],
  markdown: [".md", ".markdown"],
  toml: [".toml"],
  yaml: [".yaml", ".yml"],
} as const;

/** Languages with reviewed source-fact extraction, kept separate by language. */
const FACT_LANGUAGES: Partial<Record<Language, FactLanguageDefinition>> = {
  typescript: {
    extensions: SOURCE_FACT_LANGUAGE_EXTENSIONS.typescript,
    extract: extractTypeScriptFacts,
    relationships: true,
  },
  javascript: {
    extensions: SOURCE_FACT_LANGUAGE_EXTENSIONS.javascript,
    extract: extractJavaScriptFacts,
    relationships: true,
  },
  python: {
    extensions: SOURCE_FACT_LANGUAGE_EXTENSIONS.python,
    extract: extractPythonFacts,
    relationships: true,
  },
  go: {
    extensions: SOURCE_FACT_LANGUAGE_EXTENSIONS.go,
    extract: extractGoFacts,
    relationships: true,
  },
  rust: {
    extensions: SOURCE_FACT_LANGUAGE_EXTENSIONS.rust,
    extract: extractRustFacts,
    relationships: true,
  },
  java: {
    extensions: SOURCE_FACT_LANGUAGE_EXTENSIONS.java,
    extract: extractJavaFacts,
    relationships: true,
  },
  c: {
    extensions: SOURCE_FACT_LANGUAGE_EXTENSIONS.c,
    extract: extractCFacts,
    relationships: true,
  },
  cpp: {
    extensions: SOURCE_FACT_LANGUAGE_EXTENSIONS.cpp,
    extract: extractCppFacts,
    relationships: true,
  },
  csharp: {
    extensions: SOURCE_FACT_LANGUAGE_EXTENSIONS.csharp,
    extract: extractCSharpFacts,
    relationships: true,
  },
  ruby: {
    extensions: SOURCE_FACT_LANGUAGE_EXTENSIONS.ruby,
    extract: extractRubyFacts,
    relationships: true,
  },
  php: {
    extensions: SOURCE_FACT_LANGUAGE_EXTENSIONS.php,
    extract: extractPhpFacts,
    relationships: true,
  },
  scala: {
    extensions: SOURCE_FACT_LANGUAGE_EXTENSIONS.scala,
    extract: extractScalaFacts,
    relationships: true,
  },
  kotlin: {
    extensions: SOURCE_FACT_LANGUAGE_EXTENSIONS.kotlin,
    extract: extractKotlinFacts,
    relationships: true,
  },
  lua: {
    extensions: SOURCE_FACT_LANGUAGE_EXTENSIONS.lua,
    extract: extractLuaFacts,
    relationships: true,
  },
  zig: {
    extensions: SOURCE_FACT_LANGUAGE_EXTENSIONS.zig,
    extract: extractZigFacts,
    relationships: true,
  },
  elixir: {
    extensions: SOURCE_FACT_LANGUAGE_EXTENSIONS.elixir,
    extract: extractElixirFacts,
    relationships: true,
  },
  bash: {
    extensions: SOURCE_FACT_LANGUAGE_EXTENSIONS.bash,
    extract: extractBashFacts,
    relationships: true,
  },
  haskell: {
    extensions: SOURCE_FACT_LANGUAGE_EXTENSIONS.haskell,
    extract: extractHaskellFacts,
    relationships: true,
  },
  ocaml: {
    extensions: SOURCE_FACT_LANGUAGE_EXTENSIONS.ocaml,
    extract: extractOcamlFacts,
    relationships: true,
  },
  dart: {
    extensions: SOURCE_FACT_LANGUAGE_EXTENSIONS.dart,
    extract: extractDartFacts,
    relationships: true,
  },
  html: {
    extensions: SOURCE_FACT_LANGUAGE_EXTENSIONS.html,
    extract: extractHtmlFacts,
    relationships: true,
  },
  css: {
    extensions: SOURCE_FACT_LANGUAGE_EXTENSIONS.css,
    extract: extractCssFacts,
    relationships: true,
  },
  toml: {
    extensions: SOURCE_FACT_LANGUAGE_EXTENSIONS.toml,
    extract: extractTomlFacts,
    relationships: true,
  },
  yaml: {
    extensions: SOURCE_FACT_LANGUAGE_EXTENSIONS.yaml,
    extract: extractYamlFacts,
    relationships: true,
  },
};

/** Extensions included in project-level fact analysis. */
export const SOURCE_FACT_EXTENSIONS: ReadonlySet<string> = new Set(
  Object.values(FACT_LANGUAGES).flatMap((definition) => definition.extensions),
);

/** Extensions whose facts have reviewed project-relationship semantics. */
export const SOURCE_RELATIONSHIP_EXTENSIONS: ReadonlySet<string> = new Set(
  [
    ...Object.values(FACT_LANGUAGES)
      .filter((definition) => definition.relationships)
      .flatMap((definition) => definition.extensions),
    ...SOURCE_FACT_LANGUAGE_EXTENSIONS.markdown,
  ],
);

export function extractSourceFacts(
  language: Language,
  tree: Tree,
  chunks: SourceChunk[],
  lineStarts: number[],
): SourceFact[] {
  return FACT_LANGUAGES[language]?.extract(tree, chunks, lineStarts) ?? [];
}
