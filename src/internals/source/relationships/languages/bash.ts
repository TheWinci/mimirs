import type {
  CallFact,
  ImportFact,
} from "@winci/bun-chunk";

import {
  normalized,
} from "../shared.ts";

import {
  namedChunkTargets,
  uniqueTarget,
} from "../targets.ts";

import type {
  ResolvedTarget,
} from "../targets.ts";

import type {
  FileContext,
} from "../types.ts";

export function resolveBashSource(
  fact: ImportFact,
  files: Map<string, FileContext>,
): FileContext | null {
  if (fact.source.startsWith("/") || !fact.source.includes("/")) return null;
  const target = files.get(normalized(fact.source));
  return target?.result.language === "bash" ? target : null;
}
export function bashSourcedTarget(
  file: FileContext,
  fact: CallFact,
  files: Map<string, FileContext>,
): ResolvedTarget | null {
  if (fact.binding !== "unknown" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(fact.callee)) {
    return null;
  }
  const candidates = file.imports.flatMap((imported) => {
    if (imported.owner !== null || imported.startOffset > fact.startOffset) return [];
    const target = resolveBashSource(imported, files);
    return target
      ? namedChunkTargets(target, fact.callee, new Set(["function"]))
      : [];
  });
  return uniqueTarget(candidates);
}
