import type {
  CallFact,
  SourceChunkRef,
} from "@winci/bun-chunk";

import {
  namedChunkTargets,
  resolveLocalHeader,
  uniqueTarget,
} from "../targets.ts";

import type {
  ResolvedTarget,
} from "../targets.ts";

import type {
  FileContext,
} from "../types.ts";

const C_CALLABLE_KINDS = new Set<SourceChunkRef["kind"]>(["function", "macro"]);
export function cIncludedTarget(
  file: FileContext,
  fact: CallFact,
  files: Map<string, FileContext>,
): ResolvedTarget | null {
  if (fact.binding !== "unknown" || !/^[A-Za-z_]\w*$/.test(fact.callee)) return null;
  const candidates = file.imports.flatMap((imported) => {
    const target = resolveLocalHeader(file, imported.source, files);
    return target ? namedChunkTargets(target, fact.callee, C_CALLABLE_KINDS) : [];
  });
  return uniqueTarget(candidates);
}
