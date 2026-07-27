import type { SourceFact } from "@winci/bun-chunk";

function lines(fact: SourceFact): string {
  return fact.startLine === fact.endLine
    ? `${fact.startLine}`
    : `${fact.startLine}–${fact.endLine}`;
}

function pythonImportLabel(fact: Extract<SourceFact, { kind: "import" }>): string {
  const owner = fact.owner === null ? "" : ` in ${fact.owner.kind} ${fact.owner.name}`;
  const typeOnly = fact.typeOnly ? " (type-only)" : "";
  if (fact.imported === "*" && fact.local !== null) {
    const defaultBinding = fact.source.split(".")[0];
    const alias = fact.local === defaultBinding ? "" : ` as ${fact.local}`;
    return `import ${fact.source}${alias}${owner}${typeOnly} [${lines(fact)}]`;
  }
  if (fact.imported === "*" && fact.local === null) {
    return `from ${fact.source} import *${owner}${typeOnly} [${lines(fact)}]`;
  }
  const alias = fact.local === fact.imported ? "" : ` as ${fact.local}`;
  return `from ${fact.source} import ${fact.imported}${alias}${owner}${typeOnly} [${lines(fact)}]`;
}

function goImportLabel(fact: Extract<SourceFact, { kind: "import" }>): string {
  const name = fact.local === null ? "" : `${fact.local} `;
  return `import ${name}"${fact.source}" [${lines(fact)}]`;
}

function rustImportLabel(fact: Extract<SourceFact, { kind: "import" }>): string {
  if (fact.imported === "module") {
    const owner = fact.owner === null ? "" : ` in ${fact.owner.kind} ${fact.owner.name}`;
    return `mod ${fact.source}${owner} [${lines(fact)}]`;
  }
  const expected = fact.source.split("::").at(-1);
  const alias = fact.local === null || fact.local === expected ? "" : ` as ${fact.local}`;
  const wildcard = fact.local === null ? "::*" : "";
  const owner = fact.owner === null ? "" : ` in ${fact.owner.kind} ${fact.owner.name}`;
  return `use ${fact.source}${wildcard}${alias}${owner} [${lines(fact)}]`;
}

function javaImportLabel(fact: Extract<SourceFact, { kind: "import" }>): string {
  if (fact.imported === "module") {
    const modifiers = [fact.global ? "transitive" : "", fact.static ? "static" : ""]
      .filter(Boolean)
      .join(" ");
    return `requires${modifiers ? ` ${modifiers}` : ""} ${fact.source} [${lines(fact)}]`;
  }
  const prefix = fact.static ? "import static " : "import ";
  const member = fact.imported === "*" && fact.local !== null
    ? ""
    : `.${fact.imported}`;
  return `${prefix}${fact.source}${member} [${lines(fact)}]`;
}

function cIncludeLabel(fact: Extract<SourceFact, { kind: "import" }>): string {
  const owner = fact.owner === null ? "" : ` in ${fact.owner.kind} ${fact.owner.name}`;
  return `#include ${fact.source}${owner} [${lines(fact)}]`;
}

function cppImportLabel(fact: Extract<SourceFact, { kind: "import" }>): string {
  const owner = fact.owner === null ? "" : ` in ${fact.owner.kind} ${fact.owner.name}`;
  if (fact.imported === null) return `#include ${fact.source}${owner} [${lines(fact)}]`;
  if (fact.imported === "*" && fact.local === null) {
    return `using namespace ${fact.source}${owner} [${lines(fact)}]`;
  }
  if (fact.imported === "*" && fact.local !== null) {
    return `namespace ${fact.local} = ${fact.source}${owner} [${lines(fact)}]`;
  }
  return `using ${fact.source}::${fact.imported}${owner} [${lines(fact)}]`;
}

function csharpImportLabel(fact: Extract<SourceFact, { kind: "import" }>): string {
  const prefix = `${fact.global ? "global " : ""}using `;
  const owner = fact.owner === null ? "" : ` in ${fact.owner.kind} ${fact.owner.name}`;
  if (fact.local !== null) {
    return `${prefix}${fact.local} = ${fact.source}${owner} [${lines(fact)}]`;
  }
  const staticKeyword = fact.static ? "static " : "";
  return `${prefix}${staticKeyword}${fact.source}${owner} [${lines(fact)}]`;
}

function rubyImportLabel(fact: Extract<SourceFact, { kind: "import" }>): string {
  const method = fact.imported ?? "require";
  const owner = fact.owner === null ? "" : ` in ${fact.owner.kind} ${fact.owner.name}`;
  const binding = method === "autoload" && fact.local
    ? ` :${fact.local},`
    : "";
  return `${method}${binding} "${fact.source}"${owner} [${lines(fact)}]`;
}

function phpImportLabel(fact: Extract<SourceFact, { kind: "import" }>): string {
  const owner = fact.owner === null ? "" : ` in ${fact.owner.kind} ${fact.owner.name}`;
  if (["require", "require_once", "include", "include_once"].includes(fact.imported ?? "")) {
    return `${fact.imported} "${fact.source}"${owner} [${lines(fact)}]`;
  }
  const kind = fact.imported === "class" ? "" : `${fact.imported} `;
  const expected = fact.source.split("\\").at(-1);
  const alias = fact.local === expected ? "" : ` as ${fact.local}`;
  return `use ${kind}${fact.source}${alias}${owner} [${lines(fact)}]`;
}

function scalaImportLabel(fact: Extract<SourceFact, { kind: "import" }>): string {
  const owner = fact.owner === null ? "" : ` in ${fact.owner.kind} ${fact.owner.name}`;
  const path = fact.source ? `${fact.source}.` : "";
  const imported = fact.imported ?? "*";
  if (imported === "*" || imported === "given" || imported.startsWith("given ")) {
    return `import ${path}${imported}${owner} [${lines(fact)}]`;
  }
  const alias = fact.local === imported
    ? ""
    : ` as ${fact.local ?? "_"}`;
  return `import ${path}${imported}${alias}${owner} [${lines(fact)}]`;
}

function kotlinImportLabel(fact: Extract<SourceFact, { kind: "import" }>): string {
  const owner = fact.owner === null ? "" : ` in ${fact.owner.kind} ${fact.owner.name}`;
  const path = fact.source ? `${fact.source}.` : "";
  if (fact.imported === "*") {
    return `import ${path}*${owner} [${lines(fact)}]`;
  }
  const alias = fact.local === fact.imported ? "" : ` as ${fact.local}`;
  return `import ${path}${fact.imported}${alias}${owner} [${lines(fact)}]`;
}

function luaImportLabel(fact: Extract<SourceFact, { kind: "import" }>): string {
  const owner = fact.owner === null ? "" : ` in ${fact.owner.kind} ${fact.owner.name}`;
  const binding = fact.local === null ? "" : `local ${fact.local} = `;
  const loader = fact.imported === "*" ? "require" : fact.imported;
  return `${binding}${loader} "${fact.source}"${owner} [${lines(fact)}]`;
}

function zigImportLabel(fact: Extract<SourceFact, { kind: "import" }>): string {
  const owner = fact.owner === null ? "" : ` in ${fact.owner.kind} ${fact.owner.name}`;
  if (fact.imported === "c-header") {
    return `@cInclude("${fact.source}")${owner} [${lines(fact)}]`;
  }
  const binding = fact.local === null ? "" : `const ${fact.local} = `;
  if (fact.imported === "resource") {
    return `${binding}@embedFile("${fact.source}")${owner} [${lines(fact)}]`;
  }
  return `${binding}@import("${fact.source}")${owner} [${lines(fact)}]`;
}

function elixirImportLabel(fact: Extract<SourceFact, { kind: "import" }>): string {
  const owner = fact.owner === null ? "" : ` in ${fact.owner.kind} ${fact.owner.name}`;
  const directive = fact.imported ?? "import";
  if (fact.imported?.startsWith("except ")) {
    const [name, arity] = fact.imported.slice("except ".length).split("/");
    return `import ${fact.source}, except: [${name}: ${arity}]${owner} [${lines(fact)}]`;
  }
  if (fact.static && fact.local !== null && fact.imported?.includes("/")) {
    const [name, arity] = fact.imported.split("/");
    return `import ${fact.source}, only: [${name}: ${arity}]${owner} [${lines(fact)}]`;
  }
  const expected = fact.source.split(".").at(-1);
  const alias = directive === "alias" && fact.local !== expected
    ? `, as: ${fact.local}`
    : "";
  return `${directive} ${fact.source}${alias}${owner} [${lines(fact)}]`;
}

function bashImportLabel(fact: Extract<SourceFact, { kind: "import" }>): string {
  const owner = fact.owner === null ? "" : ` in ${fact.owner.kind} ${fact.owner.name}`;
  return `${fact.imported ?? "source"} "${fact.source}"${owner} [${lines(fact)}]`;
}

function haskellImportLabel(fact: Extract<SourceFact, { kind: "import" }>): string {
  const owner = fact.owner === null ? "" : ` in ${fact.owner.kind} ${fact.owner.name}`;
  if (fact.imported === "*" && fact.local !== null) {
    return `import qualified ${fact.source} as ${fact.local}${owner} [${lines(fact)}]`;
  }
  if (fact.imported === "*") {
    return `import ${fact.source}.*${owner} [${lines(fact)}]`;
  }
  if (fact.imported?.startsWith("qualified hiding ")) {
    return `import qualified ${fact.source} hiding (${fact.imported.slice("qualified hiding ".length)})${owner} [${lines(fact)}]`;
  }
  if (fact.imported?.startsWith("qualified ")) {
    return `import qualified ${fact.source} (${fact.imported.slice("qualified ".length)})${owner} [${lines(fact)}]`;
  }
  if (fact.imported?.startsWith("hiding ")) {
    return `import ${fact.source} hiding (${fact.imported.slice("hiding ".length)})${owner} [${lines(fact)}]`;
  }
  return `import ${fact.source} (${fact.imported})${owner} [${lines(fact)}]`;
}

function ocamlImportLabel(fact: Extract<SourceFact, { kind: "import" }>): string {
  const owner = fact.owner === null ? "" : ` in ${fact.owner.kind} ${fact.owner.name}`;
  if (fact.imported === "module") {
    return `module ${fact.local} = ${fact.source}${owner} [${lines(fact)}]`;
  }
  return `${fact.imported} ${fact.source}${owner} [${lines(fact)}]`;
}

function dartImportLabel(fact: Extract<SourceFact, { kind: "import" }>): string {
  const owner = fact.owner === null ? "" : ` in ${fact.owner.kind} ${fact.owner.name}`;
  if (fact.imported === "part" || fact.imported === "part of") {
    return `${fact.imported} "${fact.source}"${owner} [${lines(fact)}]`;
  }
  if (fact.imported === "conditional") {
    return `import "${fact.source}" (conditional)${owner} [${lines(fact)}]`;
  }
  if (fact.imported === "*" && fact.local !== null) {
    return `import "${fact.source}" as ${fact.local}${owner} [${lines(fact)}]`;
  }
  if (fact.imported === "*") return `import "${fact.source}"${owner} [${lines(fact)}]`;
  return `import "${fact.source}" show ${fact.imported}${owner} [${lines(fact)}]`;
}

function htmlImportLabel(fact: Extract<SourceFact, { kind: "import" }>): string {
  const owner = fact.owner === null ? "" : ` in ${fact.owner.kind} ${fact.owner.name}`;
  if (fact.imported?.startsWith("asset:")) {
    return `${fact.imported.slice("asset:".length)} "${fact.source}"${owner} [${lines(fact)}]`;
  }
  return `${fact.imported} "${fact.source}"${owner} [${lines(fact)}]`;
}

function cssImportLabel(fact: Extract<SourceFact, { kind: "import" }>): string {
  const owner = fact.owner === null ? "" : ` in ${fact.owner.kind} ${fact.owner.name}`;
  const kind = fact.imported?.startsWith("asset:")
    ? fact.imported.slice("asset:".length)
    : "@import";
  return `${kind} "${fact.source}"${owner} [${lines(fact)}]`;
}

function markdownImportLabel(fact: Extract<SourceFact, { kind: "import" }>): string {
  const owner = fact.owner === null ? "" : ` in ${fact.owner.kind} ${fact.owner.name}`;
  return `${fact.imported} "${fact.source}"${owner} [${lines(fact)}]`;
}

function label(
  fact: SourceFact,
  language: "default" | "python" | "go" | "rust" | "java" | "c" | "cpp" | "csharp" | "ruby" | "php" | "scala" | "kotlin" | "lua" | "zig" | "elixir" | "bash" | "haskell" | "ocaml" | "dart" | "html" | "css" | "markdown",
): string {
  if (fact.kind === "import") {
    if (language === "python") return pythonImportLabel(fact);
    if (language === "go") return goImportLabel(fact);
    if (language === "rust") return rustImportLabel(fact);
    if (language === "java") return javaImportLabel(fact);
    if (language === "c") return cIncludeLabel(fact);
    if (language === "cpp") return cppImportLabel(fact);
    if (language === "csharp") return csharpImportLabel(fact);
    if (language === "ruby") return rubyImportLabel(fact);
    if (language === "php") return phpImportLabel(fact);
    if (language === "scala") return scalaImportLabel(fact);
    if (language === "kotlin") return kotlinImportLabel(fact);
    if (language === "lua") return luaImportLabel(fact);
    if (language === "zig") return zigImportLabel(fact);
    if (language === "elixir") return elixirImportLabel(fact);
    if (language === "bash") return bashImportLabel(fact);
    if (language === "haskell") return haskellImportLabel(fact);
    if (language === "ocaml") return ocamlImportLabel(fact);
    if (language === "dart") return dartImportLabel(fact);
    if (language === "html") return htmlImportLabel(fact);
    if (language === "css") return cssImportLabel(fact);
    if (language === "markdown") return markdownImportLabel(fact);
    if (fact.imported === null) return `import "${fact.source}" [${lines(fact)}]`;
    const binding = fact.imported === fact.local
      ? fact.imported
      : `${fact.imported} as ${fact.local}`;
    return `import ${fact.typeOnly ? "type " : ""}${binding} from "${fact.source}" [${lines(fact)}]`;
  }
  if (fact.kind === "export") {
    const binding = fact.local === null || fact.local === fact.exported
      ? fact.exported
      : `${fact.local} as ${fact.exported}`;
    const source = fact.source === null ? "" : ` from "${fact.source}"`;
    const owner = fact.owner === null ? "" : ` in ${fact.owner.kind} ${fact.owner.name}`;
    return `export ${fact.typeOnly ? "type " : ""}${binding}${source}${owner} [${lines(fact)}]`;
  }
  const owner = fact.owner === null ? "module" : `${fact.owner.kind} ${fact.owner.name}`;
  return `call ${fact.callee} in ${owner} [${lines(fact)}]`;
}

export function renderSourceFacts(filepath: string, facts: SourceFact[]): string {
  const output = [filepath];
  const language = /\.pyi?$/.test(filepath)
    ? "python"
    : filepath.endsWith(".go")
    ? "go"
    : filepath.endsWith(".rs")
    ? "rust"
    : filepath.endsWith(".java")
    ? "java"
    : /\.(?:cpp|cc|cxx|hpp|hh)$/.test(filepath)
    ? "cpp"
    : /\.(?:c|h)$/.test(filepath)
    ? "c"
    : filepath.endsWith(".cs")
    ? "csharp"
    : filepath.endsWith(".rb")
    ? "ruby"
    : filepath.endsWith(".php")
    ? "php"
    : /\.(?:scala|sc)$/.test(filepath)
    ? "scala"
    : /\.(?:kt|kts)$/.test(filepath)
    ? "kotlin"
    : filepath.endsWith(".lua")
    ? "lua"
    : filepath.endsWith(".zig")
    ? "zig"
    : /\.(?:ex|exs)$/.test(filepath)
    ? "elixir"
    : /\.(?:sh|bash)$/.test(filepath)
    ? "bash"
    : filepath.endsWith(".hs")
    ? "haskell"
    : filepath.endsWith(".ml")
    ? "ocaml"
    : filepath.endsWith(".dart")
    ? "dart"
    : /\.html?$/.test(filepath)
    ? "html"
    : filepath.endsWith(".css")
    ? "css"
    : /\.(?:md|markdown)$/.test(filepath)
    ? "markdown"
    : "default";
  if (facts.length === 0) {
    output.push("└── (no facts)");
    return output.join("\n");
  }
  for (let index = 0; index < facts.length; index++) {
    output.push(
      `${index === facts.length - 1 ? "└──" : "├──"} ${label(facts[index]!, language)}`,
    );
  }
  return output.join("\n");
}
