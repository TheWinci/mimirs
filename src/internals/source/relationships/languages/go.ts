import { posix } from "node:path";

import type {
  ImportFact,
  SourceChunkRef,
} from "@winci/bun-chunk";

import {
  normalized,
} from "../shared.ts";

import {
  uniqueTarget,
} from "../targets.ts";

import type {
  ResolvedTarget,
} from "../targets.ts";

import type {
  FileContext,
  SourceRelationshipOptions,
} from "../types.ts";

interface GoPackageContext {
  directory: string;
  name: string;
  files: FileContext[];
}
export type GoPackageIndex = Map<string, GoPackageContext[]>;
function goPackageName(file: FileContext): string | null {
  const names = file.topLevelChunks
    .filter((chunk) => chunk.kind === "package")
    .map((chunk) => chunk.name);
  return new Set(names).size === 1 ? names[0]! : null;
}
export function buildGoPackageIndex(files: FileContext[]): GoPackageIndex {
  const groups = new Map<string, GoPackageContext>();
  for (const file of files) {
    if (file.result.language !== "go") continue;
    const name = goPackageName(file);
    if (!name) continue;
    const directory = posix.dirname(file.path);
    const key = `${directory}\0${name}`;
    const group = groups.get(key) ?? { directory, name, files: [] };
    group.files.push(file);
    groups.set(key, group);
  }

  const index: GoPackageIndex = new Map();
  for (const group of groups.values()) {
    const candidates = index.get(group.directory) ?? [];
    candidates.push(group);
    index.set(group.directory, candidates);
  }
  return index;
}
function selectGoPackage(packages: GoPackageContext[]): GoPackageContext | null {
  if (packages.length === 1) return packages[0]!;
  const production = packages.filter((candidate) => !candidate.name.endsWith("_test"));
  return production.length === 1 ? production[0]! : null;
}
export function resolveGoPackage(
  file: FileContext,
  fact: ImportFact,
  packages: GoPackageIndex,
  options: SourceRelationshipOptions,
): GoPackageContext | null {
  let directory: string | null = null;
  if (fact.source.startsWith(".")) {
    directory = normalized(posix.join(posix.dirname(file.path), fact.source));
  } else if (options.goModulePath && fact.source === options.goModulePath) {
    directory = ".";
  } else if (options.goModulePath && fact.source.startsWith(`${options.goModulePath}/`)) {
    directory = normalized(fact.source.slice(options.goModulePath.length + 1));
  }
  return directory === null ? null : selectGoPackage(packages.get(directory) ?? []);
}
function goCallable(chunk: SourceChunkRef): boolean {
  return ["function", "type", "struct", "interface"].includes(chunk.kind);
}
function goExported(name: string): boolean {
  return /^\p{Lu}/u.test(name);
}
function goPackageTarget(
  targetPackage: GoPackageContext,
  name: string,
  exported: boolean,
): ResolvedTarget | null {
  if (exported && !goExported(name)) return null;
  return uniqueTarget(
    targetPackage.files.flatMap((file) =>
      file.topLevelChunks
        .filter((chunk) => chunk.name === name && goCallable(chunk))
        .map((chunk) => ({ path: file.path, chunk }))
    ),
  );
}
export function goImportedTarget(
  file: FileContext,
  callee: string,
  packages: GoPackageIndex,
  options: SourceRelationshipOptions,
): ResolvedTarget | null {
  const qualified = /^([\p{L}_][\p{L}\p{N}_]*)\.([\p{L}_][\p{L}\p{N}_]*)$/u.exec(callee);
  const candidates: ResolvedTarget[] = [];
  for (const fact of file.imports) {
    if (fact.local === "_") continue;
    const targetPackage = resolveGoPackage(file, fact, packages, options);
    if (!targetPackage) continue;
    if (qualified) {
      const binding = fact.local ?? targetPackage.name;
      if (binding !== qualified[1]) continue;
      const target = goPackageTarget(targetPackage, qualified[2]!, true);
      if (target) candidates.push(target);
    } else if (fact.local === "." && /^[\p{L}_][\p{L}\p{N}_]*$/u.test(callee)) {
      const target = goPackageTarget(targetPackage, callee, true);
      if (target) candidates.push(target);
    }
  }
  return uniqueTarget(candidates);
}
export function goSamePackageTarget(
  file: FileContext,
  callee: string,
  packages: GoPackageIndex,
): ResolvedTarget | null {
  if (!/^[\p{L}_][\p{L}\p{N}_]*$/u.test(callee)) return null;
  const name = goPackageName(file);
  if (!name) return null;
  const current = (packages.get(posix.dirname(file.path)) ?? [])
    .find((candidate) => candidate.name === name);
  return current ? goPackageTarget(current, callee, false) : null;
}
