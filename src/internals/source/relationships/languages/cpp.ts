import type {
  CallFact,
  SourceChunk,
  SourceChunkRef,
} from "@winci/bun-chunk";

import {
  chunkRef,
} from "../shared.ts";

import {
  resolveLocalHeader,
  uniqueTarget,
} from "../targets.ts";

import type {
  ResolvedTarget,
} from "../targets.ts";

import type {
  FileContext,
} from "../types.ts";

const CPP_CALLABLE_KINDS = new Set<SourceChunkRef["kind"]>([
  "function",
  "method",
  "macro",
  "class",
  "struct",
]);
function cppQualifiedTargets(file: FileContext, qualifiedName: string): ResolvedTarget[] {
  const targets: ResolvedTarget[] = [];
  function visit(chunks: SourceChunk[], prefix: string[] = []): void {
    for (const chunk of chunks) {
      const value = chunkRef(chunk);
      const scopes = value && ["module", "class", "struct"].includes(value.kind)
        ? [...prefix, value.name]
        : prefix;
      if (value && CPP_CALLABLE_KINDS.has(value.kind)) {
        const name = value.name.includes("::")
          ? value.name
          : [...prefix, value.name].join("::");
        if (name === qualifiedName) targets.push({ path: file.path, chunk: value });
      }
      visit(chunk.children, scopes);
    }
  }
  visit(file.result.chunks);
  return targets;
}
export function cppIncludedTarget(
  file: FileContext,
  fact: CallFact,
  files: Map<string, FileContext>,
): ResolvedTarget | null {
  if (!["unknown", "import"].includes(fact.binding)) return null;
  const callee = fact.callee.replace(/<[^<>]*>/g, "");
  const names = new Set([callee]);
  for (const imported of file.imports) {
    if (imported.imported === null) continue;
    if (imported.imported !== "*" && imported.local === callee) {
      names.add(`${imported.source}::${imported.imported}`);
    } else if (
      imported.imported === "*" && imported.local !== null &&
      callee.startsWith(`${imported.local}::`)
    ) {
      names.add(`${imported.source}${callee.slice(imported.local.length)}`);
    }
  }
  const headers = file.imports.flatMap((imported) => {
    const target = imported.imported === null
      ? resolveLocalHeader(file, imported.source, files)
      : null;
    return target ? [target] : [];
  });
  return uniqueTarget(
    headers.flatMap((header) => [...names].flatMap((name) => cppQualifiedTargets(header, name))),
  );
}
