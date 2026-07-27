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
} from "../types.ts";

interface ElixirModuleContext {
  name: string;
  file: FileContext;
  chunk: SourceChunk;
}
export type ElixirModuleIndex = Map<string, ElixirModuleContext[]>;
export function buildElixirModuleIndex(files: FileContext[]): ElixirModuleIndex {
  const index: ElixirModuleIndex = new Map();
  function visit(file: FileContext, chunks: SourceChunk[]): void {
    for (const chunk of chunks) {
      if (chunk.kind === "module" && chunk.name !== null) {
        const candidates = index.get(chunk.name) ?? [];
        candidates.push({ name: chunk.name, file, chunk });
        index.set(chunk.name, candidates);
      }
      visit(file, chunk.children);
    }
  }
  for (const file of files) {
    if (file.result.language === "elixir") visit(file, file.result.chunks);
  }
  return index;
}
function elixirModuleFile(
  index: ElixirModuleIndex,
  name: string,
): FileContext | null {
  const files = uniqueFiles((index.get(name) ?? []).map((module) => module.file));
  return files.length === 1 ? files[0]! : null;
}
function elixirMemberTarget(
  index: ElixirModuleIndex,
  moduleName: string,
  member: string,
): ResolvedTarget | null {
  return uniqueTarget((index.get(moduleName) ?? []).flatMap((module) =>
    module.chunk.children.flatMap((chunk) => {
      const value = chunkRef(chunk);
      return value && ["function", "method"].includes(value.kind) && value.name === member
        ? [{ path: module.file.path, chunk: value }]
        : [];
    })
  ));
}
export function resolveElixirImport(
  fact: ImportFact,
  index: ElixirModuleIndex,
): FileContext | null {
  return elixirModuleFile(index, fact.source);
}
export function elixirCallTarget(
  file: FileContext,
  fact: CallFact,
  index: ElixirModuleIndex,
): ResolvedTarget | null {
  if (!["unknown", "import"].includes(fact.binding)) return null;
  const parts = fact.callee.split(".").filter(Boolean);
  if (parts.length === 0) return null;
  const root = parts[0]!;
  const candidates: ResolvedTarget[] = [];

  for (const imported of file.imports) {
    if (imported.local !== root || imported.imported === null) continue;
    if (["alias", "require"].includes(imported.imported) && parts.length === 2) {
      const target = elixirMemberTarget(index, imported.source, parts[1]!);
      if (target) candidates.push(target);
    } else if (imported.imported.includes("/") && parts.length === 1) {
      const [name] = imported.imported.split("/");
      const target = name ? elixirMemberTarget(index, imported.source, name) : null;
      if (target) candidates.push(target);
    }
  }

  if (parts.length >= 2) {
    const target = elixirMemberTarget(
      index,
      parts.slice(0, -1).join("."),
      parts.at(-1)!,
    );
    if (target) candidates.push(target);
  }
  return uniqueTarget(candidates);
}
