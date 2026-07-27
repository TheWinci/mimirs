import { posix } from "node:path";

import type {
  CallFact,
  ImportFact,
  SourceChunk,
} from "@winci/bun-chunk";

import {
  chunkRef,
  context,
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

interface OcamlModuleContext {
  name: string;
  file: FileContext;
  chunk: SourceChunk | null;
}
export type OcamlModuleIndex = Map<string, OcamlModuleContext[]>;
function ocamlUnitName(path: string): string | null {
  const extension = posix.extname(path);
  if (extension !== ".ml" && extension !== ".mli") return null;
  const basename = posix.basename(path, extension);
  return basename.length > 0
    ? `${basename[0]!.toUpperCase()}${basename.slice(1)}`
    : null;
}
export function buildOcamlModuleIndex(files: FileContext[]): OcamlModuleIndex {
  const index: OcamlModuleIndex = new Map();
  const paths = new Set(files.map((file) => file.path));
  function add(context: OcamlModuleContext): void {
    const candidates = index.get(context.name) ?? [];
    candidates.push(context);
    index.set(context.name, candidates);
  }
  function visit(
    file: FileContext,
    chunks: SourceChunk[],
    prefix: string,
  ): void {
    for (const chunk of chunks) {
      if (chunk.kind !== "module" || chunk.name === null) continue;
      const name = `${prefix}.${chunk.name}`;
      add({ name, file, chunk });
      visit(file, chunk.children, name);
    }
  }
  for (const file of files) {
    if (file.result.language !== "ocaml") continue;
    if (
      file.path.endsWith(".mli") &&
      paths.has(`${file.path.slice(0, -1)}`)
    ) continue;
    const unit = ocamlUnitName(file.path);
    if (!unit) continue;
    add({ name: unit, file, chunk: null });
    visit(file, file.result.chunks, unit);
  }
  return index;
}
function ocamlModuleContexts(
  file: FileContext,
  name: string,
  index: OcamlModuleIndex,
): OcamlModuleContext[] {
  const direct = index.get(name) ?? [];
  const unit = ocamlUnitName(file.path);
  const local = unit ? index.get(`${unit}.${name}`) ?? [] : [];
  return [...direct, ...local];
}
function ocamlModuleFile(
  file: FileContext,
  name: string,
  index: OcamlModuleIndex,
): FileContext | null {
  const files = uniqueFiles(ocamlModuleContexts(file, name, index).map(
    (module) => module.file,
  ));
  return files.length === 1 ? files[0]! : null;
}
function ocamlMemberTarget(
  file: FileContext,
  moduleName: string,
  member: string,
  index: OcamlModuleIndex,
): ResolvedTarget | null {
  return uniqueTarget(ocamlModuleContexts(file, moduleName, index).flatMap((module) => {
    const chunks = module.chunk?.children ?? module.file.result.chunks;
    return chunks.flatMap((chunk) => {
      const value = chunkRef(chunk);
      return value && ["function", "class"].includes(value.kind) && value.name === member
        ? [{ path: module.file.path, chunk: value }]
        : [];
    });
  }));
}
export function resolveOcamlImport(
  file: FileContext,
  fact: ImportFact,
  index: OcamlModuleIndex,
): FileContext | null {
  return ocamlModuleFile(file, fact.source, index);
}
export function ocamlCallTarget(
  file: FileContext,
  fact: CallFact,
  index: OcamlModuleIndex,
): ResolvedTarget | null {
  if (!["unknown", "import"].includes(fact.binding) || /#/.test(fact.callee)) return null;
  const parts = fact.callee.split(".").filter(Boolean);
  const root = parts[0];
  if (!root) return null;
  const candidates: ResolvedTarget[] = [];
  for (const imported of file.imports) {
    if (imported.imported !== "module" || imported.local !== root || parts.length !== 2) {
      continue;
    }
    const target = ocamlMemberTarget(file, imported.source, parts[1]!, index);
    if (target) candidates.push(target);
  }
  if (parts.length >= 2) {
    const target = ocamlMemberTarget(
      file,
      parts.slice(0, -1).join("."),
      parts.at(-1)!,
      index,
    );
    if (target) candidates.push(target);
  }
  return uniqueTarget(candidates);
}
