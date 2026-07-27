import { posix } from "node:path";

import type {
  CallFact,
  ImportFact,
  SourceChunk,
} from "@winci/bun-chunk";

import {
  chunkRef,
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

interface RubyConstantContext {
  qualifiedName: string;
  file: FileContext;
  chunk: SourceChunk;
}
type RubyConstantIndex = Map<string, RubyConstantContext[]>;
export function resolveRubyRequire(
  file: FileContext,
  fact: ImportFact,
  files: Map<string, FileContext>,
): FileContext | null {
  if (fact.imported !== "require" && fact.imported !== "require_relative") {
    return null;
  }
  const suffixes = posix.extname(fact.source) ? [fact.source] : [fact.source, `${fact.source}.rb`];
  const bases = fact.imported === "require_relative"
    ? [posix.dirname(file.path)]
    : [".", "lib"];
  const candidates = uniqueFiles(bases.flatMap((base) => suffixes.flatMap((suffix) => {
    const target = files.get(normalized(posix.join(base, suffix)));
    return target?.result.language === "ruby" ? [target] : [];
  })));
  return candidates.length === 1 ? candidates[0]! : null;
}
export function buildRubyConstantIndex(files: FileContext[]): RubyConstantIndex {
  const index: RubyConstantIndex = new Map();
  function visit(file: FileContext, chunks: SourceChunk[], prefix: string[] = []): void {
    for (const chunk of chunks) {
      if (
        (chunk.kind === "module" || chunk.kind === "class") && chunk.name !== null &&
        !(chunk.kind === "class" && chunk.name === "singleton self")
      ) {
        const parts = chunk.name.split("::");
        const names = chunk.name.includes("::") ? parts : [...prefix, ...parts];
        const qualifiedName = names.join("::");
        const candidates = index.get(qualifiedName) ?? [];
        candidates.push({ qualifiedName, file, chunk });
        index.set(qualifiedName, candidates);
        visit(file, chunk.children, names);
      }
    }
  }
  for (const file of files) {
    if (file.result.language === "ruby") visit(file, file.result.chunks);
  }
  return index;
}
function rubyMethodTargets(
  constant: RubyConstantContext,
  name: string,
): ResolvedTarget[] {
  const targets: ResolvedTarget[] = [];
  function visit(chunks: SourceChunk[], singleton = false): void {
    for (const chunk of chunks) {
      const nextSingleton = singleton || chunk.kind === "class" && chunk.name === "singleton self";
      const value = chunkRef(chunk);
      const directSingleton = chunk.text?.trimStart().startsWith(`def self.${name}`) === true;
      if (
        value?.kind === "method" && value.name === name &&
        (singleton || directSingleton)
      ) targets.push({ path: constant.file.path, chunk: value });
      if (nextSingleton || chunk.kind !== "class" && chunk.kind !== "module") {
        visit(chunk.children, nextSingleton);
      }
    }
  }
  visit(constant.chunk.children);
  return targets;
}
export function rubyCallTarget(
  file: FileContext,
  fact: CallFact,
  files: Map<string, FileContext>,
  constants: RubyConstantIndex,
): ResolvedTarget | null {
  if (fact.binding !== "unknown" || !/[.:]/.test(fact.callee)) return null;
  const parts = fact.callee.split(/::|\.|&\./).filter(Boolean);
  if (parts.length < 2) return null;
  const method = parts.pop()!;
  const constantName = parts.join("::");
  const requiredPaths = new Set(file.imports.flatMap((imported) => {
    const target = resolveRubyRequire(file, imported, files);
    return target ? [target.path] : [];
  }));
  const matches = constantName.includes("::")
    ? constants.get(constantName) ?? []
    : [...constants.values()].flat().filter(
      (constant) => constant.qualifiedName.split("::").at(-1) === constantName,
    );
  const eligible = matches.filter((constant) => requiredPaths.has(constant.file.path));
  if (method === "new") {
    return uniqueTarget(eligible.map((constant) => ({
      path: constant.file.path,
      chunk: chunkRef(constant.chunk)!,
    })));
  }
  return uniqueTarget(eligible.flatMap((constant) => rubyMethodTargets(constant, method)));
}
