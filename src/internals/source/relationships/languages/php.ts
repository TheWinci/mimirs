import { posix } from "node:path";

import type {
  CallFact,
  ImportFact,
  SourceChunk,
} from "@winci/bun-chunk";

import {
  chunkRef,
  context,
  normalized,
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
} from "../types.ts";

interface PhpSymbolContext {
  namespaceName: string;
  qualifiedName: string;
  file: FileContext;
  chunk: SourceChunk;
}
export interface PhpSymbolIndex {
  namespaces: Map<string, FileContext[]>;
  types: Map<string, PhpSymbolContext[]>;
  functions: Map<string, PhpSymbolContext[]>;
  constants: Map<string, PhpSymbolContext[]>;
}
export const PHP_RUNTIME_IMPORTS = new Set([
  "require",
  "require_once",
  "include",
  "include_once",
]);
export function resolvePhpRuntimeImport(
  file: FileContext,
  fact: ImportFact,
  files: Map<string, FileContext>,
): FileContext | null {
  if (!PHP_RUNTIME_IMPORTS.has(fact.imported ?? "") || posix.isAbsolute(fact.source)) return null;
  const bases = fact.source.startsWith(".") ? [posix.dirname(file.path)] : [posix.dirname(file.path), "."];
  const candidates = uniqueFiles(bases.flatMap((base) => {
    const target = files.get(normalized(posix.join(base, fact.source)));
    return target?.result.language === "php" ? [target] : [];
  }));
  return candidates.length === 1 ? candidates[0]! : null;
}
export function buildPhpSymbolIndex(files: FileContext[]): PhpSymbolIndex {
  const namespaces = new Map<string, FileContext[]>();
  const types = new Map<string, PhpSymbolContext[]>();
  const functions = new Map<string, PhpSymbolContext[]>();
  const constants = new Map<string, PhpSymbolContext[]>();

  function add(
    index: Map<string, PhpSymbolContext[]>,
    context: PhpSymbolContext,
  ): void {
    const candidates = index.get(context.qualifiedName) ?? [];
    candidates.push(context);
    index.set(context.qualifiedName, candidates);
  }

  function visit(file: FileContext, chunks: SourceChunk[], namespaceName = ""): void {
    for (const chunk of chunks) {
      if (chunk.kind === "module" && chunk.name !== null) {
        const name = chunk.name === "(global)" ? "" : chunk.name.replace(/^\\/, "");
        const namespaceFiles = namespaces.get(name) ?? [];
        namespaceFiles.push(file);
        namespaces.set(name, namespaceFiles);
        visit(file, chunk.children, name);
        continue;
      }
      if (chunk.name === null) continue;
      const qualifiedName = [...(namespaceName ? [namespaceName] : []), chunk.name].join("\\");
      const context = { namespaceName, qualifiedName, file, chunk };
      if (["class", "interface", "trait", "enum"].includes(chunk.kind)) add(types, context);
      else if (chunk.kind === "function") add(functions, context);
      else if (chunk.kind === "constant") add(constants, context);
    }
  }

  for (const file of files) {
    if (file.result.language !== "php") continue;
    const globalFiles = namespaces.get("") ?? [];
    globalFiles.push(file);
    namespaces.set("", globalFiles);
    visit(file, file.result.chunks);
  }
  return { namespaces, types, functions, constants };
}
function selectPhpSymbol(
  index: Map<string, PhpSymbolContext[]>,
  name: string,
): PhpSymbolContext | null {
  const candidates = index.get(name.replace(/^\\/, "")) ?? [];
  return candidates.length === 1 ? candidates[0]! : null;
}
export function resolvePhpUse(
  fact: ImportFact,
  index: PhpSymbolIndex,
): FileContext | null {
  if (PHP_RUNTIME_IMPORTS.has(fact.imported ?? "")) return null;
  const symbols = fact.imported === "function"
    ? index.functions
    : fact.imported === "const"
    ? index.constants
    : index.types;
  return selectPhpSymbol(symbols, fact.source)?.file ?? null;
}
function phpNamespaceAt(file: FileContext, offset: number): string {
  let selected = "";
  let size = Number.POSITIVE_INFINITY;
  function visit(chunks: SourceChunk[]): void {
    for (const chunk of chunks) {
      if (
        chunk.kind === "module" && chunk.name !== null && chunk.startOffset <= offset &&
        chunk.endOffset >= offset && chunk.endOffset - chunk.startOffset < size
      ) {
        selected = chunk.name === "(global)" ? "" : chunk.name.replace(/^\\/, "");
        size = chunk.endOffset - chunk.startOffset;
      }
      visit(chunk.children);
    }
  }
  visit(file.result.chunks);
  return selected;
}
function phpTypeCallTarget(
  type: PhpSymbolContext,
  method: string | null,
): ResolvedTarget | null {
  if (method === null || method === "__construct") {
    return { path: type.file.path, chunk: chunkRef(type.chunk)! };
  }
  return uniqueTarget(type.chunk.children.flatMap((chunk) => {
    const value = chunkRef(chunk);
    return value?.kind === "method" && value.name === method
      ? [{ path: type.file.path, chunk: value }]
      : [];
  }));
}
export function phpCallTarget(
  file: FileContext,
  fact: CallFact,
  index: PhpSymbolIndex,
): ResolvedTarget | null {
  if (!["unknown", "import"].includes(fact.binding)) return null;
  const callee = fact.callee.replace(/^\\/, "");
  const scoped = /^(.*)::([^:]+)$/.exec(callee);
  const namespaceName = phpNamespaceAt(file, fact.startOffset);
  const candidates: ResolvedTarget[] = [];

  if (scoped || /^[A-Z_\\][A-Za-z0-9_\\]*$/.test(callee)) {
    const typeSpelling = scoped?.[1] ?? callee;
    const method = scoped?.[2] ?? null;
    for (const imported of file.imports) {
      if (imported.imported !== "class" || imported.local !== typeSpelling) continue;
      const type = selectPhpSymbol(index.types, imported.source);
      const target = type ? phpTypeCallTarget(type, method) : null;
      if (target) candidates.push(target);
    }
    const names = typeSpelling.includes("\\")
      ? [typeSpelling]
      : [[namespaceName, typeSpelling].filter(Boolean).join("\\")];
    for (const name of names) {
      const type = selectPhpSymbol(index.types, name);
      const target = type ? phpTypeCallTarget(type, method) : null;
      if (target) candidates.push(target);
    }
  } else if (/^[A-Za-z_]\w*$/.test(callee)) {
    for (const imported of file.imports) {
      if (imported.imported !== "function" || imported.local !== callee) continue;
      const fn = selectPhpSymbol(index.functions, imported.source);
      if (fn) candidates.push({ path: fn.file.path, chunk: chunkRef(fn.chunk)! });
    }
    const local = selectPhpSymbol(
      index.functions,
      [namespaceName, callee].filter(Boolean).join("\\"),
    );
    if (local) candidates.push({ path: local.file.path, chunk: chunkRef(local.chunk)! });
  }
  return uniqueTarget(candidates);
}
