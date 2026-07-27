import { posix } from "node:path";

import type {
  SourceChunkRef,
} from "@winci/bun-chunk";
import { SOURCE_FACT_LANGUAGE_EXTENSIONS } from "@winci/bun-chunk";

import {
  normalized,
} from "../shared.ts";

import { isCallable } from "../targets.ts";
import type {
  ResolvedTarget,
} from "../targets.ts";

import type {
  FileContext,
} from "../types.ts";

export function resolveEcmaScriptImport(
  fromPath: string,
  source: string,
  files: Map<string, FileContext>,
): FileContext | null {
  if (!source.startsWith(".")) return null;
  const base = normalized(posix.join(posix.dirname(fromPath), source));
  const candidates = [base];
  const extension = posix.extname(base);
  if (extension === ".js") {
    candidates.push(base.slice(0, -extension.length) + ".ts");
  } else if (extension === ".jsx") {
    candidates.push(
      base.slice(0, -extension.length) + ".tsx",
      base.slice(0, -extension.length) + ".ts",
    );
  } else if (extension === ".mjs") {
    candidates.push(
      base.slice(0, -extension.length) + ".mts",
      base.slice(0, -extension.length) + ".ts",
    );
  } else if (extension === ".cjs") {
    candidates.push(
      base.slice(0, -extension.length) + ".cts",
      base.slice(0, -extension.length) + ".ts",
    );
  } else if (!/\.[^/]+$/.test(base)) {
    const javascriptFirst = /\.[cm]?js$/.test(fromPath);
    const extensions = javascriptFirst
      ? [
        ...SOURCE_FACT_LANGUAGE_EXTENSIONS.javascript,
        ...SOURCE_FACT_LANGUAGE_EXTENSIONS.typescript,
      ]
      : [
        ...SOURCE_FACT_LANGUAGE_EXTENSIONS.typescript,
        ...SOURCE_FACT_LANGUAGE_EXTENSIONS.javascript,
      ];
    candidates.push(...extensions.map((candidate) => `${base}${candidate}`));
    candidates.push(...extensions.map((candidate) => `${base}/index${candidate}`));
  }
  for (const candidate of candidates) {
    const found = files.get(normalized(candidate));
    if (found) return found;
  }
  return null;
}
function exportedTarget(
  file: FileContext,
  exported: string,
  files: Map<string, FileContext>,
  visited: Set<string> = new Set(),
): ResolvedTarget | null {
  const visitKey = `${file.path}\0${exported}`;
  if (visited.has(visitKey)) return null;
  const nextVisited = new Set(visited);
  nextVisited.add(visitKey);
  const candidates: ResolvedTarget[] = [];

  for (const fact of file.exports) {
    if (fact.owner !== null || fact.typeOnly) continue;
    if (fact.source === null) {
      if (fact.exported !== exported || fact.local === null) continue;
      const name = fact.local;
      for (const chunk of file.topLevelChunks) {
        if (chunk.name === name && isCallable(chunk)) {
          candidates.push({ path: file.path, chunk });
        }
      }
      continue;
    }

    const followsNamedExport = fact.exported === exported;
    const followsStarExport = fact.exported === "*" && exported !== "default";
    if (!followsNamedExport && !followsStarExport) continue;
    const targetFile = resolveEcmaScriptImport(file.path, fact.source, files);
    if (!targetFile) continue;
    const targetName = followsStarExport ? exported : fact.local ?? exported;
    const target = exportedTarget(targetFile, targetName, files, nextVisited);
    if (target) candidates.push(target);
  }

  const unique = new Map(
    candidates.map((candidate) => [
      `${candidate.path}\0${candidate.chunk.startOffset}\0${candidate.chunk.endOffset}`,
      candidate,
    ]),
  );
  return unique.size === 1 ? unique.values().next().value! : null;
}
export function importedEcmaScriptTarget(
  file: FileContext,
  callee: string,
  files: Map<string, FileContext>,
): { path: string; chunk: SourceChunkRef } | null {
  const direct = file.imports.find(
    (fact) => !fact.typeOnly && fact.local === callee && fact.imported !== null &&
      fact.imported !== "*",
  );
  if (direct) {
    const targetFile = resolveEcmaScriptImport(file.path, direct.source, files);
    const target = targetFile ? exportedTarget(targetFile, direct.imported!, files) : null;
    if (target) return target;
  }

  const member = /^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/.exec(callee);
  if (!member) return null;
  const namespace = file.imports.find(
    (fact) => !fact.typeOnly && fact.imported === "*" && fact.local === member[1],
  );
  if (!namespace) return null;
  const targetFile = resolveEcmaScriptImport(file.path, namespace.source, files);
  return targetFile ? exportedTarget(targetFile, member[2]!, files) : null;
}
