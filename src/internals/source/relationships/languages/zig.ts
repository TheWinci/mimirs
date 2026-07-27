import { posix } from "node:path";

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

export function resolveZigImport(
  file: FileContext,
  fact: ImportFact,
  files: Map<string, FileContext>,
): FileContext | null {
  if (fact.imported === "c-header" || !fact.source.endsWith(".zig")) return null;
  const path = normalized(posix.join(posix.dirname(file.path), fact.source));
  const target = files.get(path);
  return target?.result.language === "zig" ? target : null;
}
export function zigImportedTarget(
  file: FileContext,
  fact: CallFact,
  files: Map<string, FileContext>,
): ResolvedTarget | null {
  if (fact.binding !== "import") return null;
  const parts = fact.callee.split(".").filter(Boolean);
  if (parts.length !== 2) return null;
  const candidates = file.imports.flatMap((imported) => {
    if (imported.local !== parts[0] || imported.imported === "c-header") return [];
    const target = resolveZigImport(file, imported, files);
    return target
      ? namedChunkTargets(target, parts[1]!, new Set(["function"]))
      : [];
  });
  return uniqueTarget(candidates);
}
