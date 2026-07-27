import type {
  CallFact,
  ImportFact,
  SourceChunk,
} from "@winci/bun-chunk";

import {
  chunkRef,
  context,
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

interface CSharpTypeContext {
  namespaceName: string;
  qualifiedName: string;
  file: FileContext;
  chunk: SourceChunk;
}
interface CSharpNamespaceContext {
  name: string;
  file: FileContext;
  chunk: SourceChunk | null;
}
export interface CSharpTypeIndex {
  namespaces: Map<string, CSharpNamespaceContext[]>;
  types: Map<string, CSharpTypeContext[]>;
  globalImports: ImportFact[];
}
const CSHARP_TYPE_KINDS = new Set<SourceChunk["kind"]>([
  "class",
  "interface",
  "struct",
  "record",
  "enum",
  "delegate",
]);
export function buildCSharpTypeIndex(files: FileContext[]): CSharpTypeIndex {
  const namespaces = new Map<string, CSharpNamespaceContext[]>();
  const types = new Map<string, CSharpTypeContext[]>();
  const globalImports: ImportFact[] = [];

  function addNamespace(context: CSharpNamespaceContext): void {
    const candidates = namespaces.get(context.name) ?? [];
    candidates.push(context);
    namespaces.set(context.name, candidates);
  }

  function visit(
    file: FileContext,
    chunks: SourceChunk[],
    namespaceName = "",
    enclosingTypes: string[] = [],
  ): void {
    for (const chunk of chunks) {
      if (chunk.kind === "module" && chunk.name !== null) {
        const name = namespaceName && !chunk.name.startsWith(`${namespaceName}.`)
          ? `${namespaceName}.${chunk.name}`
          : chunk.name;
        addNamespace({ name, file, chunk });
        visit(file, chunk.children, name, []);
        continue;
      }
      if (CSHARP_TYPE_KINDS.has(chunk.kind) && chunk.name !== null) {
        const names = [...enclosingTypes, chunk.name];
        const qualifiedName = [...(namespaceName ? [namespaceName] : []), ...names].join(".");
        const candidates = types.get(qualifiedName) ?? [];
        candidates.push({ namespaceName, qualifiedName, file, chunk });
        types.set(qualifiedName, candidates);
        visit(file, chunk.children, namespaceName, names);
      }
    }
  }

  for (const file of files) {
    if (file.result.language !== "csharp") continue;
    addNamespace({ name: "", file, chunk: null });
    visit(file, file.result.chunks);
    globalImports.push(...file.imports.filter((fact) => fact.global));
  }
  return { namespaces, types, globalImports };
}
function selectCSharpType(
  index: CSharpTypeIndex,
  qualifiedName: string,
): CSharpTypeContext | null {
  const name = qualifiedName.replace(/^global::/, "");
  const candidates = index.types.get(name) ?? [];
  return candidates.length === 1 ? candidates[0]! : null;
}
function csharpTypeTarget(type: CSharpTypeContext): ResolvedTarget {
  return { path: type.file.path, chunk: chunkRef(type.chunk)! };
}
function csharpMethodTarget(
  type: CSharpTypeContext,
  name: string,
): ResolvedTarget | null {
  return uniqueTarget(type.chunk.children.flatMap((chunk) => {
    const value = chunkRef(chunk);
    return value && ["method", "function"].includes(value.kind) && value.name === name
      ? [{ path: type.file.path, chunk: value }]
      : [];
  }));
}
function csharpNamespaceAt(
  file: FileContext,
  offset: number,
  index: CSharpTypeIndex,
): string {
  let selected = "";
  let selectedSize = Number.POSITIVE_INFINITY;
  for (const contexts of index.namespaces.values()) {
    for (const context of contexts) {
      const chunk = context.chunk;
      if (context.file.path !== file.path || chunk === null) continue;
      const size = chunk.endOffset - chunk.startOffset;
      if (chunk.startOffset <= offset && chunk.endOffset >= offset && size < selectedSize) {
        selected = context.name;
        selectedSize = size;
      }
    }
  }
  return selected;
}
function csharpImports(file: FileContext, index: CSharpTypeIndex): ImportFact[] {
  return [...file.imports, ...index.globalImports.filter((fact) => !file.imports.includes(fact))];
}
export function resolveCSharpImport(
  fact: ImportFact,
  index: CSharpTypeIndex,
): { targetKind: ImportRelationship["targetKind"]; toPath: string } | null {
  const type = selectCSharpType(index, fact.source);
  if (type) return { targetKind: "file", toPath: type.file.path };
  const source = fact.source.replace(/^global::/, "");
  return index.namespaces.has(source)
    ? { targetKind: "package", toPath: source }
    : null;
}
function csharpMemberTarget(
  index: CSharpTypeIndex,
  typeName: string,
  remaining: string[],
): ResolvedTarget | null {
  const exact = selectCSharpType(index, [typeName, ...remaining].join("."));
  if (exact) return csharpTypeTarget(exact);
  const type = selectCSharpType(index, typeName);
  if (!type) return null;
  if (remaining.length === 0) return csharpTypeTarget(type);
  return remaining.length === 1 ? csharpMethodTarget(type, remaining[0]!) : null;
}
export function csharpCallTarget(
  file: FileContext,
  fact: CallFact,
  index: CSharpTypeIndex,
): ResolvedTarget | null {
  if (!["unknown", "import"].includes(fact.binding)) return null;
  const callee = fact.callee.replace(/<[^<>]*>/g, "").replace(/^global::/, "");
  const parts = callee.split(/\.|::/).filter(Boolean);
  const root = parts[0];
  if (!root) return null;
  const candidates: ResolvedTarget[] = [];

  for (const imported of csharpImports(file, index)) {
    const source = imported.source.replace(/^global::/, "");
    if (imported.static && parts.length === 1) {
      const type = selectCSharpType(index, source);
      const target = type ? csharpMethodTarget(type, root) : null;
      if (target) candidates.push(target);
    } else if (imported.local === root) {
      const target = csharpMemberTarget(index, source, parts.slice(1));
      if (target) candidates.push(target);
    } else if (!imported.static && imported.local === null) {
      const target = csharpMemberTarget(index, `${source}.${root}`, parts.slice(1));
      if (target) candidates.push(target);
    }
  }

  const namespaceName = csharpNamespaceAt(file, fact.startOffset, index);
  const local = csharpMemberTarget(
    index,
    [...(namespaceName ? [namespaceName] : []), root].join("."),
    parts.slice(1),
  );
  if (local) candidates.push(local);
  const qualified = csharpMemberTarget(index, root, parts.slice(1));
  if (qualified) candidates.push(qualified);
  return uniqueTarget(candidates);
}
