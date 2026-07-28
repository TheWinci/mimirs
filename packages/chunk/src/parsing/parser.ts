import { Parser, Language as TSLanguage, Query } from "web-tree-sitter";
import type { Language } from "../types";

let initialized = false;
export type Grammar = Language | "tsx" | "ocaml_interface";

export const GRAMMARS = [
  "typescript",
  "tsx",
  "javascript",
  "python",
  "rust",
  "go",
  "java",
  "c",
  "cpp",
  "ruby",
  "csharp",
  "php",
  "scala",
  "html",
  "css",
  "kotlin",
  "lua",
  "zig",
  "elixir",
  "bash",
  "toml",
  "yaml",
  "haskell",
  "ocaml",
  "ocaml_interface",
  "dart",
] as const satisfies readonly Grammar[];

interface CompiledRuntime {
  grammars: Readonly<Record<string, string>>;
  treeSitter: string;
}

function compiledRuntime(): CompiledRuntime | undefined {
  return (globalThis as typeof globalThis & {
    __MIMIRS_COMPILED_RUNTIME__?: CompiledRuntime;
  }).__MIMIRS_COMPILED_RUNTIME__;
}

const grammarCache = new Map<Grammar, TSLanguage>();
const queryCache = new Map<string, Query>();

/** WASM file paths per language — prefer per-package WASM, fallback to tree-sitter-wasms */
export function getGrammarPath(language: Grammar): string {
  if (language === "tsx") return "tree-sitter-typescript/tree-sitter-tsx.wasm";
  if (language === "ocaml_interface") {
    return "tree-sitter-ocaml/tree-sitter-ocaml_interface.wasm";
  }

  // Languages with their own npm package containing WASM
  const packagePaths: Partial<Record<Language, string>> = {
    typescript: "tree-sitter-typescript/tree-sitter-typescript.wasm",
    javascript: "tree-sitter-javascript/tree-sitter-javascript.wasm",
    python: "tree-sitter-python/tree-sitter-python.wasm",
    rust: "tree-sitter-rust/tree-sitter-rust.wasm",
    go: "tree-sitter-go/tree-sitter-go.wasm",
    java: "tree-sitter-java/tree-sitter-java.wasm",
    c: "tree-sitter-c/tree-sitter-c.wasm",
    cpp: "tree-sitter-cpp/tree-sitter-cpp.wasm",
    ruby: "tree-sitter-ruby/tree-sitter-ruby.wasm",
    csharp: "tree-sitter-c-sharp/tree-sitter-c_sharp.wasm",
    php: "tree-sitter-php/tree-sitter-php.wasm",
    scala: "tree-sitter-scala/tree-sitter-scala.wasm",
    html: "tree-sitter-html/tree-sitter-html.wasm",
    css: "tree-sitter-css/tree-sitter-css.wasm",
    kotlin: "@tree-sitter-grammars/tree-sitter-kotlin/tree-sitter-kotlin.wasm",
    lua: "@tree-sitter-grammars/tree-sitter-lua/tree-sitter-lua.wasm",
    zig: "@tree-sitter-grammars/tree-sitter-zig/tree-sitter-zig.wasm",
    elixir: "tree-sitter-elixir/tree-sitter-elixir.wasm",
    bash: "tree-sitter-bash/tree-sitter-bash.wasm",
    toml: "@tree-sitter-grammars/tree-sitter-toml/tree-sitter-toml.wasm",
    yaml: "@tree-sitter-grammars/tree-sitter-yaml/tree-sitter-yaml.wasm",
    haskell: "tree-sitter-haskell/tree-sitter-haskell.wasm",
    ocaml: "tree-sitter-ocaml/tree-sitter-ocaml.wasm",
    dart: "@winci/tree-sitter-dart/tree-sitter-dart.wasm",
  };

  if (packagePaths[language]) {
    return packagePaths[language]!;
  }

  throw new Error(`No grammar available for language: ${language}`);
}

async function ensureInit(): Promise<void> {
  if (!initialized) {
    const runtime = compiledRuntime();
    await Parser.init(runtime
      ? { locateFile: () => runtime.treeSitter }
      : undefined);
    initialized = true;
  }
}

async function loadGrammar(language: Grammar): Promise<TSLanguage> {
  const cached = grammarCache.get(language);
  if (cached) return cached;

  await ensureInit();
  const wasmPath = compiledRuntime()?.grammars[language] ??
    require.resolve(getGrammarPath(language));
  const grammar = await TSLanguage.load(wasmPath);
  grammarCache.set(language, grammar);
  return grammar;
}

export async function parse(code: string, language: Grammar) {
  const grammar = await loadGrammar(language);
  await ensureInit();
  const parser = new Parser();
  parser.setLanguage(grammar);
  const tree = parser.parse(code);
  return tree;
}

export async function loadQuery(language: Grammar, queryString: string, key: string = "default"): Promise<Query> {
  const cacheKey = `${language}:${key}`;
  const cached = queryCache.get(cacheKey);
  if (cached) return cached;

  const grammar = await loadGrammar(language);
  const query = new Query(grammar, queryString);
  queryCache.set(cacheKey, query);
  return query;
}
