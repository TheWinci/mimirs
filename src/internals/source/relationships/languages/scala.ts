import type {
  CallFact,
  ImportFact,
  SourceChunk,
} from "@winci/bun-chunk";

import {
  chunkRef,
  context,
  uniqueFiles,
} from "../shared.ts";

import {
  uniqueTarget,
} from "../targets.ts";

import type {
  ResolvedTarget,
} from "../targets.ts";

import type {
  FileContext,
  ImportRelationship,
} from "../types.ts";

interface ScalaSymbolContext {
  packageName: string;
  qualifiedName: string;
  file: FileContext;
  chunk: SourceChunk;
}
export interface ScalaSymbolIndex {
  packages: Map<string, FileContext[]>;
  types: Map<string, ScalaSymbolContext[]>;
  functions: Map<string, ScalaSymbolContext[]>;
}
const SCALA_TYPE_KINDS = new Set<SourceChunk["kind"]>([
  "class",
  "trait",
  "enum",
  "type",
  "module",
  "given",
]);
export function buildScalaSymbolIndex(files: FileContext[]): ScalaSymbolIndex {
  const packages = new Map<string, FileContext[]>();
  const types = new Map<string, ScalaSymbolContext[]>();
  const functions = new Map<string, ScalaSymbolContext[]>();

  function addPackage(name: string, file: FileContext): void {
    const candidates = packages.get(name) ?? [];
    candidates.push(file);
    packages.set(name, candidates);
  }
  function add(
    index: Map<string, ScalaSymbolContext[]>,
    context: ScalaSymbolContext,
  ): void {
    const candidates = index.get(context.qualifiedName) ?? [];
    candidates.push(context);
    index.set(context.qualifiedName, candidates);
  }
  function visit(
    file: FileContext,
    chunks: SourceChunk[],
    packageName = "",
    enclosingTypes: string[] = [],
  ): void {
    for (const chunk of chunks) {
      if (chunk.kind === "package" && chunk.name !== null) {
        const name = packageName && !chunk.name.startsWith(`${packageName}.`)
          ? `${packageName}.${chunk.name}`
          : chunk.name;
        addPackage(name, file);
        visit(file, chunk.children, name, []);
        continue;
      }
      if (SCALA_TYPE_KINDS.has(chunk.kind) && chunk.name !== null) {
        const names = [...enclosingTypes, chunk.name];
        const qualifiedName = [...(packageName ? [packageName] : []), ...names].join(".");
        add(types, { packageName, qualifiedName, file, chunk });
        visit(file, chunk.children, packageName, names);
        continue;
      }
      if (
        enclosingTypes.length === 0 && chunk.name !== null &&
        ["function", "method"].includes(chunk.kind)
      ) {
        const qualifiedName = [packageName, chunk.name].filter(Boolean).join(".");
        add(functions, { packageName, qualifiedName, file, chunk });
      }
    }
  }

  for (const file of files) {
    if (file.result.language !== "scala") continue;
    addPackage("", file);
    visit(file, file.result.chunks);
  }
  return { packages, types, functions };
}
export function scalaSymbols(
  index: Map<string, ScalaSymbolContext[]>,
  qualifiedName: string,
): ScalaSymbolContext[] {
  return index.get(qualifiedName) ?? [];
}
function scalaUniqueFile(symbols: ScalaSymbolContext[]): FileContext | null {
  const files = uniqueFiles(symbols.map((symbol) => symbol.file));
  return files.length === 1 ? files[0]! : null;
}
function scalaTypeTarget(
  symbols: ScalaSymbolContext[],
): ResolvedTarget | null {
  const constructible = symbols.filter((symbol) =>
    ["class", "enum", "type"].includes(symbol.chunk.kind)
  );
  return uniqueTarget(constructible.map((symbol) => ({
    path: symbol.file.path,
    chunk: chunkRef(symbol.chunk)!,
  })));
}
function scalaMemberTarget(
  symbols: ScalaSymbolContext[],
  name: string,
): ResolvedTarget | null {
  return uniqueTarget(symbols.flatMap((symbol) =>
    symbol.chunk.children.flatMap((chunk) => {
      const value = chunkRef(chunk);
      return value && ["method", "function"].includes(value.kind) && value.name === name
        ? [{ path: symbol.file.path, chunk: value }]
        : [];
    })
  ));
}
export function resolveScalaImport(
  fact: ImportFact,
  index: ScalaSymbolIndex,
): { targetKind: ImportRelationship["targetKind"]; toPath: string } | null {
  if (fact.imported === "*" || fact.imported === "given" || fact.imported?.startsWith("given ")) {
    const owner = scalaUniqueFile(scalaSymbols(index.types, fact.source));
    if (owner) return { targetKind: "file", toPath: owner.path };
    return index.packages.has(fact.source)
      ? { targetKind: "package", toPath: fact.source }
      : null;
  }
  const qualified = [fact.source, fact.imported].filter(Boolean).join(".");
  const symbolFile = scalaUniqueFile([
    ...scalaSymbols(index.types, qualified),
    ...scalaSymbols(index.functions, qualified),
  ]);
  if (symbolFile) return { targetKind: "file", toPath: symbolFile.path };
  const owner = scalaUniqueFile(scalaSymbols(index.types, fact.source));
  const hasMember = scalaSymbols(index.types, fact.source).some((symbol) =>
    symbol.chunk.children.some((chunk) => chunk.name === fact.imported)
  );
  return owner && hasMember
    ? { targetKind: "file", toPath: owner.path }
    : null;
}
function scalaPackageAt(file: FileContext, offset: number): string {
  let selected = "";
  let size = Number.POSITIVE_INFINITY;
  function visit(chunks: SourceChunk[], packageName = ""): void {
    for (const chunk of chunks) {
      if (chunk.kind === "package" && chunk.name !== null) {
        const name = packageName && !chunk.name.startsWith(`${packageName}.`)
          ? `${packageName}.${chunk.name}`
          : chunk.name;
        const chunkSize = chunk.endOffset - chunk.startOffset;
        if (chunk.startOffset <= offset && chunk.endOffset >= offset && chunkSize < size) {
          selected = name;
          size = chunkSize;
        }
        visit(chunk.children, name);
      }
    }
  }
  visit(file.result.chunks);
  return selected;
}
function scalaCallFromQualified(
  name: string,
  remaining: string[],
  index: ScalaSymbolIndex,
): ResolvedTarget | null {
  if (remaining.length === 0) {
    const fn = uniqueTarget(scalaSymbols(index.functions, name).map((symbol) => ({
      path: symbol.file.path,
      chunk: chunkRef(symbol.chunk)!,
    })));
    return fn ?? scalaTypeTarget(scalaSymbols(index.types, name));
  }
  return remaining.length === 1
    ? scalaMemberTarget(scalaSymbols(index.types, name), remaining[0]!)
    : null;
}
export function scalaCallTarget(
  file: FileContext,
  fact: CallFact,
  index: ScalaSymbolIndex,
): ResolvedTarget | null {
  if (!["unknown", "import"].includes(fact.binding)) return null;
  const callee = fact.callee.replace(/\[[^\[\]]*\]/g, "");
  if (/\s/.test(callee)) return null;
  const parts = callee.split(".").filter(Boolean);
  const root = parts[0];
  if (!root) return null;
  const candidates: ResolvedTarget[] = [];

  for (const imported of file.imports) {
    if (imported.local !== root || imported.imported === null) continue;
    const qualified = [imported.source, imported.imported].filter(Boolean).join(".");
    const direct = scalaCallFromQualified(qualified, parts.slice(1), index);
    if (direct) candidates.push(direct);
    if (parts.length === 1) {
      const member = scalaMemberTarget(scalaSymbols(index.types, imported.source), imported.imported);
      if (member) candidates.push(member);
    }
  }

  const packageName = scalaPackageAt(file, fact.startOffset);
  const local = scalaCallFromQualified(
    [packageName, root].filter(Boolean).join("."),
    parts.slice(1),
    index,
  );
  if (local) candidates.push(local);
  const qualified = scalaCallFromQualified(root, parts.slice(1), index);
  if (qualified) candidates.push(qualified);
  return uniqueTarget(candidates);
}
