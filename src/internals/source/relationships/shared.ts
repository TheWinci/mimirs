import { posix } from "node:path";

import type {
  CallFact,
  ExportFact,
  ImportFact,
  SourceChunk,
  SourceChunkRef,
} from "@winci/bun-chunk";

import type {
  AnalyzedSourceFile,
  FileContext,
  SourceRelationshipOptions,
} from "./types.ts";

export function parseGoModulePath(source: string): string | null {
  for (const line of source.split(/\r?\n/)) {
    const match = /^\s*module\s+(?:"([^"]+)"|`([^`]+)`|(\S+))/.exec(line);
    const path = match?.[1] ?? match?.[2] ?? match?.[3];
    if (path) return path;
  }
  return null;
}

export function normalized(path: string): string {
  const value = posix.normalize(path.replaceAll("\\", "/"));
  return value.startsWith("./") ? value.slice(2) : value;
}

export const RESOURCE_LANGUAGES = new Set(["html", "css", "markdown"]);

export function localResourcePath(
  file: FileContext,
  source: string,
): string | null {
  if (/^(?:[A-Za-z][A-Za-z0-9+.-]*:|\/\/)/.test(source)) return null;
  const withoutSuffix = source.split(/[?#]/, 1)[0];
  if (!withoutSuffix) return null;
  return normalized(
    withoutSuffix.startsWith("/")
      ? withoutSuffix.slice(1)
      : posix.join(posix.dirname(file.path), withoutSuffix),
  );
}

export function resolveProjectResource(
  file: FileContext,
  source: string,
  files: Map<string, FileContext>,
  options: SourceRelationshipOptions,
): string | null {
  const path = localResourcePath(file, source);
  if (!path) return null;
  const projectPaths = options.projectPaths ?? new Set(files.keys());
  return projectPaths.has(path) ? path : null;
}

export function chunkRef(chunk: SourceChunk): SourceChunkRef | null {
  if (chunk.name === null) return null;
  return {
    kind: chunk.kind,
    name: chunk.name,
    startOffset: chunk.startOffset,
    endOffset: chunk.endOffset,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
  };
}

export function context(file: AnalyzedSourceFile): FileContext {
  const facts = file.result.facts;
  return {
    ...file,
    path: normalized(file.path),
    topLevelChunks: file.result.chunks.flatMap((chunk) => {
      const value = chunkRef(chunk);
      return value ? [value] : [];
    }),
    imports: facts.filter((fact): fact is ImportFact => fact.kind === "import"),
    exports: facts.filter((fact): fact is ExportFact => fact.kind === "export"),
    calls: facts.filter((fact): fact is CallFact => fact.kind === "call"),
  };
}

export function uniqueFiles(files: FileContext[]): FileContext[] {
  return [...new Map(files.map((file) => [file.path, file])).values()];
}
