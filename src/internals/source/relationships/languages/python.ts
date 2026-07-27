import { posix } from "node:path";

import type {
  ImportFact,
  SourceChunkRef,
} from "@winci/bun-chunk";

import {
  uniqueFiles,
} from "../shared.ts";

import {
  isCallable,
  uniqueTarget,
} from "../targets.ts";

import type {
  ResolvedTarget,
} from "../targets.ts";

import type {
  FileContext,
} from "../types.ts";

export type PythonModuleIndex = Map<string, FileContext[]>;
function pythonModuleNames(path: string): string[] {
  const extension = posix.extname(path);
  if (extension !== ".py" && extension !== ".pyi") return [];
  const parts = path.slice(0, -extension.length).split("/");
  if (parts.at(-1) === "__init__") parts.pop();
  const names = [parts.join(".")];
  if (parts[0] === "src" && parts.length > 1) names.push(parts.slice(1).join("."));
  return [...new Set(names.filter(Boolean))];
}
export function buildPythonModuleIndex(files: FileContext[]): PythonModuleIndex {
  const index: PythonModuleIndex = new Map();
  for (const file of files) {
    if (file.result.language !== "python") continue;
    for (const name of pythonModuleNames(file.path)) {
      const candidates = index.get(name) ?? [];
      candidates.push(file);
      index.set(name, candidates);
    }
  }
  return index;
}
function selectPythonModule(files: FileContext[]): FileContext | null {
  const candidates = uniqueFiles(files);
  const implementations = candidates.filter((file) => file.path.endsWith(".py"));
  if (implementations.length === 1) return implementations[0]!;
  if (implementations.length > 1) return null;
  return candidates.length === 1 ? candidates[0]! : null;
}
function pythonImportModuleNames(file: FileContext, source: string): string[] {
  const relative = /^(\.+)(.*)$/.exec(source);
  if (!relative) return [source];
  const level = relative[1]!.length;
  const suffix = relative[2]!.split(".").filter(Boolean);
  const names: string[] = [];
  for (const currentName of pythonModuleNames(file.path)) {
    const current = currentName.split(".");
    const packageParts = /(?:^|\/)__init__\.pyi?$/.test(file.path)
      ? current
      : current.slice(0, -1);
    if (level - 1 > packageParts.length) continue;
    names.push([...packageParts.slice(0, packageParts.length - (level - 1)), ...suffix].join("."));
  }
  return [...new Set(names.filter(Boolean))];
}
export function resolvePythonImport(
  file: FileContext,
  fact: ImportFact,
  modules: PythonModuleIndex,
): FileContext | null {
  const moduleNames = pythonImportModuleNames(file, fact.source);
  const base = selectPythonModule(
    moduleNames.flatMap((name) => modules.get(name) ?? []),
  );
  if (!fact.imported || fact.imported === "*") return base;
  if (base?.topLevelChunks.some((chunk) => chunk.name === fact.imported)) return base;

  const child = selectPythonModule(
    moduleNames.flatMap((name) => modules.get(`${name}.${fact.imported}`) ?? []),
  );
  if (child) return child;
  return base;
}
function pythonCallable(chunk: SourceChunkRef): boolean {
  return isCallable(chunk) || chunk.kind === "class";
}
function pythonSymbolTarget(
  file: FileContext,
  name: string,
  modules: PythonModuleIndex,
  visited: Set<string> = new Set(),
): ResolvedTarget | null {
  const visitKey = `${file.path}\0${name}`;
  if (visited.has(visitKey)) return null;
  const nextVisited = new Set(visited);
  nextVisited.add(visitKey);
  const candidates: ResolvedTarget[] = file.topLevelChunks
    .filter((chunk) => chunk.name === name && pythonCallable(chunk))
    .map((chunk) => ({ path: file.path, chunk }));

  for (const fact of file.imports) {
    if (
      fact.owner !== null || fact.typeOnly || fact.local !== name ||
      fact.imported === null || fact.imported === "*"
    ) continue;
    const targetFile = resolvePythonImport(file, fact, modules);
    if (!targetFile) continue;
    const target = pythonSymbolTarget(
      targetFile,
      fact.imported,
      modules,
      nextVisited,
    );
    if (target) candidates.push(target);
  }
  return uniqueTarget(candidates);
}
export function pythonImportedTarget(
  file: FileContext,
  callee: string,
  modules: PythonModuleIndex,
): ResolvedTarget | null {
  const parts = callee.split(".");
  const root = parts[0];
  if (!root) return null;
  const candidates: ResolvedTarget[] = [];

  for (const fact of file.imports) {
    if (fact.typeOnly || fact.local !== root) continue;
    const targetFile = resolvePythonImport(file, fact, modules);
    if (!targetFile) continue;

    if (fact.imported !== null && fact.imported !== "*") {
      const direct = pythonSymbolTarget(targetFile, fact.imported, modules);
      if (parts.length === 1 && direct) candidates.push(direct);
      if (parts.length === 2 && !direct) {
        const member = pythonSymbolTarget(targetFile, parts[1]!, modules);
        if (member) candidates.push(member);
      }
      continue;
    }

    const sourceParts = fact.source.replace(/^\.+/, "").split(".").filter(Boolean);
    const prefix = !fact.source.startsWith(".") && fact.local === sourceParts[0]
      ? sourceParts
      : [root];
    if (
      parts.length !== prefix.length + 1 ||
      !prefix.every((part, index) => parts[index] === part)
    ) continue;
    const member = pythonSymbolTarget(targetFile, parts.at(-1)!, modules);
    if (member) candidates.push(member);
  }
  return uniqueTarget(candidates);
}
