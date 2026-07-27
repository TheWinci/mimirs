import type {
  CallFact,
  ImportFact,
} from "@winci/bun-chunk";

import {
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

interface HaskellModuleContext {
  name: string;
  file: FileContext;
}
export type HaskellModuleIndex = Map<string, HaskellModuleContext[]>;
export function buildHaskellModuleIndex(files: FileContext[]): HaskellModuleIndex {
  const index: HaskellModuleIndex = new Map();
  for (const file of files) {
    if (file.result.language !== "haskell") continue;
    for (const chunk of file.topLevelChunks) {
      if (chunk.kind !== "module") continue;
      const candidates = index.get(chunk.name) ?? [];
      candidates.push({ name: chunk.name, file });
      index.set(chunk.name, candidates);
    }
  }
  return index;
}
function haskellModuleFile(
  index: HaskellModuleIndex,
  name: string,
): FileContext | null {
  const files = uniqueFiles((index.get(name) ?? []).map((module) => module.file));
  return files.length === 1 ? files[0]! : null;
}
function haskellMemberTarget(
  index: HaskellModuleIndex,
  moduleName: string,
  member: string,
): ResolvedTarget | null {
  const kind = /^[A-Z]/.test(member) ? "type" : "function";
  return uniqueTarget((index.get(moduleName) ?? []).flatMap((module) =>
    module.file.topLevelChunks.flatMap((chunk) =>
      chunk.kind === kind && chunk.name === member
        ? [{ path: module.file.path, chunk }]
        : []
    )
  ));
}
export function resolveHaskellImport(
  fact: ImportFact,
  index: HaskellModuleIndex,
): FileContext | null {
  return haskellModuleFile(index, fact.source);
}
export function haskellCallTarget(
  file: FileContext,
  fact: CallFact,
  index: HaskellModuleIndex,
): ResolvedTarget | null {
  if (!["unknown", "import"].includes(fact.binding)) return null;
  const parts = fact.callee.split(".").filter(Boolean);
  const root = parts[0];
  if (!root) return null;
  const candidates: ResolvedTarget[] = [];
  for (const imported of file.imports) {
    if (imported.local === root && imported.imported === "*" && parts.length === 2) {
      const target = haskellMemberTarget(index, imported.source, parts[1]!);
      if (target) candidates.push(target);
    } else if (
      imported.local === root && imported.imported === root && parts.length === 1
    ) {
      const target = haskellMemberTarget(index, imported.source, root);
      if (target) candidates.push(target);
    }
  }
  if (parts.length >= 2) {
    const target = haskellMemberTarget(
      index,
      parts.slice(0, -1).join("."),
      parts.at(-1)!,
    );
    if (target) candidates.push(target);
  }
  return uniqueTarget(candidates);
}
