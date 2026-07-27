import type {
  CallFact,
  ImportFact,
  SourceChunk,
} from "@winci/bun-chunk";

import {
  chunkRef,
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

interface JavaTypeContext {
  packageName: string;
  qualifiedName: string;
  file: FileContext;
  chunk: SourceChunk;
}
export interface JavaTypeIndex {
  packages: Map<string, FileContext[]>;
  types: Map<string, JavaTypeContext[]>;
}
const JAVA_TYPE_KINDS = new Set<SourceChunk["kind"]>([
  "class",
  "interface",
  "record",
  "enum",
  "annotation_type",
]);
function javaPackageName(file: FileContext): string | null {
  const names = file.topLevelChunks
    .filter((chunk) => chunk.kind === "package")
    .map((chunk) => chunk.name);
  if (names.length === 0) return "";
  return new Set(names).size === 1 ? names[0]! : null;
}
export function buildJavaTypeIndex(files: FileContext[]): JavaTypeIndex {
  const packages = new Map<string, FileContext[]>();
  const types = new Map<string, JavaTypeContext[]>();

  function addTypes(
    file: FileContext,
    packageName: string,
    chunks: SourceChunk[],
    enclosing: string[] = [],
  ): void {
    for (const chunk of chunks) {
      if (!JAVA_TYPE_KINDS.has(chunk.kind) || chunk.name === null) continue;
      const names = [...enclosing, chunk.name];
      const qualifiedName = [...(packageName ? [packageName] : []), ...names].join(".");
      const candidates = types.get(qualifiedName) ?? [];
      candidates.push({ packageName, qualifiedName, file, chunk });
      types.set(qualifiedName, candidates);
      addTypes(file, packageName, chunk.children, names);
    }
  }

  for (const file of files) {
    if (file.result.language !== "java") continue;
    const packageName = javaPackageName(file);
    if (packageName === null) continue;
    const packageFiles = packages.get(packageName) ?? [];
    packageFiles.push(file);
    packages.set(packageName, packageFiles);
    addTypes(file, packageName, file.result.chunks);
  }
  return { packages, types };
}
function selectJavaType(
  index: JavaTypeIndex,
  qualifiedName: string,
): JavaTypeContext | null {
  const candidates = index.types.get(qualifiedName) ?? [];
  return candidates.length === 1 ? candidates[0]! : null;
}
function javaTypeTarget(type: JavaTypeContext): ResolvedTarget {
  return { path: type.file.path, chunk: chunkRef(type.chunk)! };
}
function javaMethodTarget(type: JavaTypeContext, name: string): ResolvedTarget | null {
  return uniqueTarget(
    type.chunk.children.flatMap((chunk) => {
      const value = chunkRef(chunk);
      return value?.kind === "method" && value.name === name
        ? [{ path: type.file.path, chunk: value }]
        : [];
    }),
  );
}
export function resolveJavaImport(
  fact: ImportFact,
  index: JavaTypeIndex,
): { targetKind: ImportRelationship["targetKind"]; toPath: string } | null {
  if (fact.imported === "module") return null;
  if (fact.static || fact.local !== null) {
    const type = selectJavaType(index, fact.source);
    return type ? { targetKind: "file", toPath: type.file.path } : null;
  }
  return index.packages.has(fact.source)
    ? { targetKind: "package", toPath: fact.source }
    : null;
}
function javaImportedTarget(
  file: FileContext,
  callee: string,
  index: JavaTypeIndex,
): ResolvedTarget | null {
  const normalizedCallee = callee.replace(/\.<[^>]+>/g, ".");
  const parts = normalizedCallee.split(".").filter(Boolean);
  const root = parts[0];
  if (!root) return null;
  const candidates: ResolvedTarget[] = [];

  for (const fact of file.imports) {
    if (fact.static) {
      if (fact.imported === "*" || fact.local !== normalizedCallee) continue;
      const type = selectJavaType(index, fact.source);
      const target = type ? javaMethodTarget(type, fact.imported!) : null;
      if (target) candidates.push(target);
      continue;
    }
    if (fact.local !== root) continue;
    const type = selectJavaType(index, fact.source);
    if (!type) continue;
    const nestedName = [type.qualifiedName, ...parts.slice(1)].join(".");
    const nested = selectJavaType(index, nestedName);
    if (nested) candidates.push(javaTypeTarget(nested));
    else if (parts.length === 1) candidates.push(javaTypeTarget(type));
    else if (parts.length === 2) {
      const target = javaMethodTarget(type, parts[1]!);
      if (target) candidates.push(target);
    }
  }
  return uniqueTarget(candidates);
}
function javaProjectTarget(
  file: FileContext,
  callee: string,
  index: JavaTypeIndex,
): ResolvedTarget | null {
  const normalizedCallee = callee.replace(/\.<[^>]+>/g, ".");
  const parts = normalizedCallee.split(".").filter(Boolean);
  if (parts.length === 0) return null;
  const candidates: ResolvedTarget[] = [];
  const packageName = javaPackageName(file);
  if (packageName !== null) {
    const localName = [...(packageName ? [packageName] : []), ...parts].join(".");
    const exact = selectJavaType(index, localName);
    if (exact) candidates.push(javaTypeTarget(exact));
    if (parts.length >= 2) {
      const ownerName = [
        ...(packageName ? [packageName] : []),
        ...parts.slice(0, -1),
      ].join(".");
      const owner = selectJavaType(index, ownerName);
      const target = owner ? javaMethodTarget(owner, parts.at(-1)!) : null;
      if (target) candidates.push(target);
    }
  }

  const exact = selectJavaType(index, normalizedCallee);
  if (exact) candidates.push(javaTypeTarget(exact));
  if (parts.length >= 2) {
    const owner = selectJavaType(index, parts.slice(0, -1).join("."));
    const target = owner ? javaMethodTarget(owner, parts.at(-1)!) : null;
    if (target) candidates.push(target);
  }
  return uniqueTarget(candidates);
}
export function javaCallTarget(
  file: FileContext,
  fact: CallFact,
  index: JavaTypeIndex,
): ResolvedTarget | null {
  if (fact.binding === "import") {
    const imported = javaImportedTarget(file, fact.callee, index);
    if (imported) return imported;
  }
  return fact.binding === "unknown" ? javaProjectTarget(file, fact.callee, index) : null;
}
