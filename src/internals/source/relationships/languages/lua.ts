import type {
  ImportFact,
} from "@winci/bun-chunk";

import {
  normalized,
  uniqueFiles,
} from "../shared.ts";

import type {
  FileContext,
} from "../types.ts";

export function luaModulePaths(source: string): string[] {
  const modulePath = source.includes("/") ? source : source.replaceAll(".", "/");
  return [`${modulePath}.lua`, `${modulePath}/init.lua`].map(normalized);
}
export function resolveLuaRequire(
  fact: ImportFact,
  files: Map<string, FileContext>,
): FileContext | null {
  if (fact.imported !== "*") return null;
  const candidates = uniqueFiles(luaModulePaths(fact.source).flatMap((path) => {
    const target = files.get(path);
    return target?.result.language === "lua" ? [target] : [];
  }));
  return candidates.length === 1 ? candidates[0]! : null;
}
