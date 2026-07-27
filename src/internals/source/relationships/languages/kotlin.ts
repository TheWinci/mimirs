import type {
  CallFact,
  ImportFact,
  SourceChunk,
} from "@winci/bun-chunk";

import {
  chunkRef,
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

interface KotlinSymbolContext {
  packageName: string;
  qualifiedName: string;
  file: FileContext;
  chunk: SourceChunk;
}
export interface KotlinSymbolIndex {
  packages: Map<string, FileContext[]>;
  types: Map<string, KotlinSymbolContext[]>;
  functions: Map<string, KotlinSymbolContext[]>;
}
const KOTLIN_TYPE_KINDS = new Set<SourceChunk["kind"]>([
  "class",
  "interface",
  "record",
  "enum",
  "annotation_type",
  "type",
]);
function kotlinPackageName(file: FileContext): string | null {
  const names = file.topLevelChunks
    .filter((chunk) => chunk.kind === "package")
    .map((chunk) => chunk.name);
  if (names.length === 0) return "";
  return new Set(names).size === 1 ? names[0]! : null;
}
export function buildKotlinSymbolIndex(files: FileContext[]): KotlinSymbolIndex {
  const packages = new Map<string, FileContext[]>();
  const types = new Map<string, KotlinSymbolContext[]>();
  const functions = new Map<string, KotlinSymbolContext[]>();

  function add(
    index: Map<string, KotlinSymbolContext[]>,
    symbol: KotlinSymbolContext,
  ): void {
    const candidates = index.get(symbol.qualifiedName) ?? [];
    candidates.push(symbol);
    index.set(symbol.qualifiedName, candidates);
  }
  function visit(
    file: FileContext,
    packageName: string,
    chunks: SourceChunk[],
    enclosingTypes: string[] = [],
  ): void {
    for (const chunk of chunks) {
      if (chunk.kind === "package") {
        visit(file, packageName, chunk.children, enclosingTypes);
        continue;
      }
      if (KOTLIN_TYPE_KINDS.has(chunk.kind) && chunk.name !== null) {
        const names = [...enclosingTypes, chunk.name];
        const qualifiedName = [packageName, ...names].filter(Boolean).join(".");
        add(types, { packageName, qualifiedName, file, chunk });
        visit(file, packageName, chunk.children, names);
        continue;
      }
      if (
        enclosingTypes.length === 0 && chunk.name !== null &&
        chunk.kind === "function"
      ) {
        const qualifiedName = [packageName, chunk.name].filter(Boolean).join(".");
        add(functions, { packageName, qualifiedName, file, chunk });
      }
    }
  }

  for (const file of files) {
    if (file.result.language !== "kotlin") continue;
    const packageName = kotlinPackageName(file);
    if (packageName === null) continue;
    const packageFiles = packages.get(packageName) ?? [];
    packageFiles.push(file);
    packages.set(packageName, packageFiles);
    visit(file, packageName, file.result.chunks);
  }
  return { packages, types, functions };
}
export function kotlinSymbols(
  index: Map<string, KotlinSymbolContext[]>,
  qualifiedName: string,
): KotlinSymbolContext[] {
  return index.get(qualifiedName) ?? [];
}
function kotlinUniqueFile(symbols: KotlinSymbolContext[]): FileContext | null {
  const files = uniqueFiles(symbols.map((symbol) => symbol.file));
  return files.length === 1 ? files[0]! : null;
}
function kotlinTypeTarget(
  symbols: KotlinSymbolContext[],
): ResolvedTarget | null {
  const constructible = symbols.filter((symbol) =>
    ["class", "record", "enum", "annotation_type", "type"].includes(
      symbol.chunk.kind,
    )
  );
  return uniqueTarget(constructible.map((symbol) => ({
    path: symbol.file.path,
    chunk: chunkRef(symbol.chunk)!,
  })));
}
function kotlinMemberTarget(
  symbols: KotlinSymbolContext[],
  name: string,
): ResolvedTarget | null {
  return uniqueTarget(symbols.flatMap((symbol) =>
    symbol.chunk.children.flatMap((chunk) => {
      const value = chunkRef(chunk);
      return value?.kind === "method" && value.name === name
        ? [{ path: symbol.file.path, chunk: value }]
        : [];
    })
  ));
}
export function resolveKotlinImport(
  fact: ImportFact,
  index: KotlinSymbolIndex,
): { targetKind: ImportRelationship["targetKind"]; toPath: string } | null {
  if (fact.imported === "*") {
    const owner = kotlinUniqueFile(kotlinSymbols(index.types, fact.source));
    if (owner) return { targetKind: "file", toPath: owner.path };
    return index.packages.has(fact.source)
      ? { targetKind: "package", toPath: fact.source }
      : null;
  }
  const qualified = [fact.source, fact.imported].filter(Boolean).join(".");
  const symbolFile = kotlinUniqueFile([
    ...kotlinSymbols(index.types, qualified),
    ...kotlinSymbols(index.functions, qualified),
  ]);
  if (symbolFile) return { targetKind: "file", toPath: symbolFile.path };
  const ownerSymbols = kotlinSymbols(index.types, fact.source);
  const owner = kotlinUniqueFile(ownerSymbols);
  const hasMember = ownerSymbols.some((symbol) =>
    symbol.chunk.children.some((chunk) => chunk.kind === "method" && chunk.name === fact.imported)
  );
  return owner && hasMember
    ? { targetKind: "file", toPath: owner.path }
    : null;
}
function kotlinCallFromQualified(
  name: string,
  remaining: string[],
  index: KotlinSymbolIndex,
): ResolvedTarget | null {
  if (remaining.length === 0) {
    const fn = uniqueTarget(kotlinSymbols(index.functions, name).map((symbol) => ({
      path: symbol.file.path,
      chunk: chunkRef(symbol.chunk)!,
    })));
    return fn ?? kotlinTypeTarget(kotlinSymbols(index.types, name));
  }
  return remaining.length === 1
    ? kotlinMemberTarget(kotlinSymbols(index.types, name), remaining[0]!)
    : null;
}
export function kotlinCallTarget(
  file: FileContext,
  fact: CallFact,
  index: KotlinSymbolIndex,
): ResolvedTarget | null {
  if (!["unknown", "import"].includes(fact.binding)) return null;
  const callee = fact.callee.replace(/<[^<>]*>/g, "");
  if (/\s|\?\./.test(callee)) return null;
  const parts = callee.split(".").filter(Boolean);
  const root = parts[0];
  if (!root) return null;
  const candidates: ResolvedTarget[] = [];

  for (const imported of file.imports) {
    if (imported.imported === "*" || imported.local !== root) continue;
    const qualified = [imported.source, imported.imported].filter(Boolean).join(".");
    const direct = kotlinCallFromQualified(qualified, parts.slice(1), index);
    if (direct) candidates.push(direct);
    if (parts.length === 1 && imported.imported !== null) {
      const member = kotlinMemberTarget(
        kotlinSymbols(index.types, imported.source),
        imported.imported,
      );
      if (member) candidates.push(member);
    }
  }

  const packageName = kotlinPackageName(file);
  if (packageName !== null) {
    const local = kotlinCallFromQualified(
      [packageName, root].filter(Boolean).join("."),
      parts.slice(1),
      index,
    );
    if (local) candidates.push(local);
  }
  const qualified = kotlinCallFromQualified(root, parts.slice(1), index);
  if (qualified) candidates.push(qualified);
  return uniqueTarget(candidates);
}
