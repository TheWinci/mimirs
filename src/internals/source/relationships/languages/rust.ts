import { posix } from "node:path";

import type {
  CallFact,
  ImportFact,
  SourceChunk,
  SourceChunkRef,
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
} from "../types.ts";

interface RustModuleContext {
  root: string;
  modulePath: string[];
  file: FileContext;
  declaration: SourceChunk | null;
  chunks: SourceChunk[];
}
export interface RustModuleIndex {
  modules: Map<string, RustModuleContext[]>;
  fileModules: Map<string, RustModuleContext>;
}
interface ResolvedRustPath {
  module: RustModuleContext;
  declaration: SourceChunkRef | null;
}
function rustModuleKey(root: string, modulePath: string[]): string {
  return `${root}\0${modulePath.join("::")}`;
}
function rustExternalModuleChunk(chunk: SourceChunk): boolean {
  return chunk.kind === "module" && chunk.children.length === 0 &&
    chunk.text?.trimEnd().endsWith(";") === true;
}
function rustFileModulePath(path: string, root: string): string[] {
  const relative = root === "." ? path : posix.relative(root, path);
  const extension = posix.extname(relative);
  const parts = relative.slice(0, -extension.length).split("/");
  if (parts.at(-1) === "lib" || parts.at(-1) === "main" || parts.at(-1) === "mod") {
    parts.pop();
  }
  return parts.filter(Boolean);
}
export function buildRustModuleIndex(files: FileContext[]): RustModuleIndex {
  const rustFiles = files.filter((file) => file.result.language === "rust");
  const roots = [...new Set(
    rustFiles
      .filter((file) => /(?:^|\/)(?:lib|main)\.rs$/.test(file.path))
      .map((file) => posix.dirname(file.path)),
  )];
  const modules = new Map<string, RustModuleContext[]>();
  const fileModules = new Map<string, RustModuleContext>();

  function add(module: RustModuleContext): void {
    const key = rustModuleKey(module.root, module.modulePath);
    const candidates = modules.get(key) ?? [];
    candidates.push(module);
    modules.set(key, candidates);
  }

  function addInlineModules(parent: RustModuleContext): void {
    for (const chunk of parent.chunks) {
      if (chunk.kind !== "module" || chunk.name === null || rustExternalModuleChunk(chunk)) {
        continue;
      }
      const module: RustModuleContext = {
        root: parent.root,
        modulePath: [...parent.modulePath, chunk.name],
        file: parent.file,
        declaration: chunk,
        chunks: chunk.children,
      };
      add(module);
      addInlineModules(module);
    }
  }

  for (const file of rustFiles) {
    const candidates = roots
      .filter((root) => root === "." || file.path.startsWith(`${root}/`) || file.path === root)
      .sort((left, right) => right.length - left.length);
    const root = candidates[0];
    if (root === undefined) continue;
    const module: RustModuleContext = {
      root,
      modulePath: rustFileModulePath(file.path, root),
      file,
      declaration: null,
      chunks: file.result.chunks,
    };
    fileModules.set(file.path, module);
    add(module);
    addInlineModules(module);
  }
  return { modules, fileModules };
}
export function rustContainingModule(
  file: FileContext,
  offset: number,
  modules: RustModuleIndex,
): RustModuleContext | null {
  const root = modules.fileModules.get(file.path);
  if (!root) return null;
  let current = root;
  for (const candidates of modules.modules.values()) {
    for (const candidate of candidates) {
      const chunk = candidate.declaration;
      if (
        candidate.file.path === file.path && chunk !== null &&
        chunk.startOffset <= offset && chunk.endOffset >= offset &&
        (current.declaration === null ||
          chunk.endOffset - chunk.startOffset <
            current.declaration.endOffset - current.declaration.startOffset)
      ) {
        current = candidate;
      }
    }
  }
  return current;
}
export function selectRustModule(
  modules: RustModuleIndex,
  root: string,
  modulePath: string[],
): RustModuleContext | null {
  const candidates = modules.modules.get(rustModuleKey(root, modulePath)) ?? [];
  return candidates.length === 1 ? candidates[0]! : null;
}
function rustDeclaration(
  module: RustModuleContext,
  name: string,
): SourceChunkRef | null {
  const declarationKinds = new Set<SourceChunkRef["kind"]>([
    "function",
    "macro",
    "struct",
    "enum",
    "trait",
    "type",
    "constant",
    "variable",
  ]);
  return uniqueTarget(
    module.chunks.flatMap((chunk) => {
      const value = chunkRef(chunk);
      return value?.name === name && declarationKinds.has(value.kind)
        ? [{ path: module.file.path, chunk: value }]
        : [];
    }),
  )?.chunk ?? null;
}
function rustPathBases(
  file: FileContext,
  source: string,
  offset: number,
  modules: RustModuleIndex,
  moduleDeclaration: boolean,
  expression: boolean,
): Array<{ root: string; path: string[]; rest: string[] }> {
  const current = rustContainingModule(file, offset, modules);
  if (!current) return [];
  const parts = source.replace(/!$/, "").split("::").filter(Boolean);
  if (moduleDeclaration) {
    return [{ root: current.root, path: current.modulePath, rest: parts }];
  }
  if (parts[0] === "crate") {
    return [{ root: current.root, path: [], rest: parts.slice(1) }];
  }
  if (parts[0] === "self") {
    return [{ root: current.root, path: current.modulePath, rest: parts.slice(1) }];
  }
  if (parts[0] === "super") {
    let count = 0;
    while (parts[count] === "super") count++;
    if (count > current.modulePath.length) return [];
    return [{
      root: current.root,
      path: current.modulePath.slice(0, current.modulePath.length - count),
      rest: parts.slice(count),
    }];
  }
  const bases = expression && current.modulePath.length > 0
    ? [current.modulePath, []]
    : [[]];
  return bases.map((path) => ({ root: current.root, path, rest: parts }));
}
function resolveRustPath(
  file: FileContext,
  source: string,
  offset: number,
  modules: RustModuleIndex,
  moduleDeclaration = false,
  expression = false,
): ResolvedRustPath | null {
  const candidates: ResolvedRustPath[] = [];
  for (const base of rustPathBases(
    file,
    source,
    offset,
    modules,
    moduleDeclaration,
    expression,
  )) {
    if (moduleDeclaration) {
      const module = selectRustModule(modules, base.root, [...base.path, ...base.rest]);
      if (module) candidates.push({ module, declaration: null });
      continue;
    }
    for (let moduleLength = base.rest.length; moduleLength >= 0; moduleLength--) {
      const module = selectRustModule(
        modules,
        base.root,
        [...base.path, ...base.rest.slice(0, moduleLength)],
      );
      if (!module) continue;
      const remaining = base.rest.slice(moduleLength);
      if (remaining.length === 0) candidates.push({ module, declaration: null });
      else if (remaining.length === 1) {
        const declaration = rustDeclaration(module, remaining[0]!);
        if (declaration) candidates.push({ module, declaration });
      }
      break;
    }
  }
  const unique = new Map(candidates.map((candidate) => [
    `${candidate.module.file.path}\0${candidate.module.modulePath.join("::")}\0` +
      `${candidate.declaration?.startOffset ?? "module"}`,
    candidate,
  ]));
  return unique.size === 1 ? unique.values().next().value! : null;
}
export function resolveRustImport(
  file: FileContext,
  fact: ImportFact,
  modules: RustModuleIndex,
): ResolvedRustPath | null {
  return resolveRustPath(
    file,
    fact.source,
    fact.startOffset,
    modules,
    fact.imported === "module",
  );
}
function rustCallable(chunk: SourceChunkRef): boolean {
  return ["function", "macro", "struct", "enum"].includes(chunk.kind);
}
function rustImportedTarget(
  file: FileContext,
  fact: CallFact,
  modules: RustModuleIndex,
): ResolvedTarget | null {
  const parts = fact.callee.replace(/!$/, "").split("::").filter(Boolean);
  const root = parts[0];
  if (!root) return null;
  const candidates: ResolvedTarget[] = [];
  for (const imported of file.imports) {
    if (imported.local !== root) continue;
    const resolved = resolveRustImport(file, imported, modules);
    if (!resolved) continue;
    if (parts.length === 1 && resolved.declaration && rustCallable(resolved.declaration)) {
      candidates.push({ path: resolved.module.file.path, chunk: resolved.declaration });
    } else if (parts.length === 2 && resolved.declaration === null) {
      const declaration = rustDeclaration(resolved.module, parts[1]!);
      if (declaration && rustCallable(declaration)) {
        candidates.push({ path: resolved.module.file.path, chunk: declaration });
      }
    }
  }
  return uniqueTarget(candidates);
}
export function rustCallTarget(
  file: FileContext,
  fact: CallFact,
  modules: RustModuleIndex,
): ResolvedTarget | null {
  if (fact.binding === "import") {
    const imported = rustImportedTarget(file, fact, modules);
    if (imported) return imported;
  }
  if (!fact.callee.includes("::")) return null;
  const resolved = resolveRustPath(
    file,
    fact.callee,
    fact.startOffset,
    modules,
    false,
    true,
  );
  return resolved?.declaration && rustCallable(resolved.declaration)
    ? { path: resolved.module.file.path, chunk: resolved.declaration }
    : null;
}
