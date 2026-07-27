import { posix } from "node:path";

import type {
  CallFact,
  ImportFact,
} from "@winci/bun-chunk";

import {
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

export type DartLibraryIndex = Map<string, FileContext[]>;
export function buildDartLibraryIndex(files: FileContext[]): DartLibraryIndex {
  const index: DartLibraryIndex = new Map();
  for (const file of files) {
    if (
      file.result.language !== "dart" ||
      file.imports.some((fact) => fact.imported === "part of")
    ) continue;
    for (const chunk of file.topLevelChunks) {
      if (chunk.kind !== "module") continue;
      const candidates = index.get(chunk.name) ?? [];
      candidates.push(file);
      index.set(chunk.name, candidates);
    }
  }
  return index;
}
export function resolveDartUri(
  file: FileContext,
  source: string,
  files: Map<string, FileContext>,
): FileContext | null {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(source)) return null;
  const target = files.get(normalized(posix.join(posix.dirname(file.path), source)));
  return target?.result.language === "dart" ? target : null;
}
export function resolveDartImport(
  file: FileContext,
  fact: ImportFact,
  files: Map<string, FileContext>,
  libraries: DartLibraryIndex,
): FileContext | null {
  if (
    fact.imported === "part of" &&
    !fact.source.includes("/") && !fact.source.endsWith(".dart")
  ) {
    const candidates = uniqueFiles(libraries.get(fact.source) ?? []);
    return candidates.length === 1 ? candidates[0]! : null;
  }
  return resolveDartUri(file, fact.source, files);
}
function dartSymbolTarget(
  file: FileContext,
  name: string,
): ResolvedTarget | null {
  return uniqueTarget(file.topLevelChunks.flatMap((chunk) =>
    ["function", "class"].includes(chunk.kind) && chunk.name === name
      ? [{ path: file.path, chunk }]
      : []
  ));
}
export function dartCallTarget(
  file: FileContext,
  fact: CallFact,
  files: Map<string, FileContext>,
  libraries: DartLibraryIndex,
): ResolvedTarget | null {
  if (!["unknown", "import"].includes(fact.binding) || /\?\.|\.\./.test(fact.callee)) {
    return null;
  }
  const parts = fact.callee.replaceAll("()", "").split(".").filter(Boolean);
  const root = parts[0];
  if (!root) return null;
  const candidates: ResolvedTarget[] = [];
  for (const imported of file.imports) {
    const targetFile = resolveDartImport(file, imported, files, libraries);
    if (!targetFile || ["part", "part of"].includes(imported.imported ?? "")) continue;
    if (
      imported.local === root &&
      (imported.imported === "*" || imported.imported === "conditional") &&
      parts.length >= 2
    ) {
      const target = dartSymbolTarget(targetFile, parts[1]!);
      if (target) candidates.push(target);
    } else if (
      imported.local === root && imported.imported === root && parts.length === 1
    ) {
      const target = dartSymbolTarget(targetFile, root);
      if (target) candidates.push(target);
    }
  }
  return uniqueTarget(candidates);
}
