import { posix } from "node:path";

import type { SourceChunk, SourceChunkRef } from "@winci/bun-chunk";

import { chunkRef, normalized } from "./shared.ts";
import type { FileContext } from "./types.ts";

/** One resolved relationship endpoint: a chunk inside a project file. */
export interface ResolvedTarget {
  path: string;
  chunk: SourceChunkRef;
}

export function resolveLocalHeader(
  file: FileContext,
  source: string,
  files: Map<string, FileContext>,
): FileContext | null {
  const quoted = /^"([^"]+)"$/.exec(source);
  if (!quoted) return null;
  return files.get(normalized(posix.join(posix.dirname(file.path), quoted[1]!))) ?? null;
}

export function namedChunkTargets(
  file: FileContext,
  name: string,
  kinds: ReadonlySet<SourceChunkRef["kind"]>,
): ResolvedTarget[] {
  const targets: ResolvedTarget[] = [];
  function visit(chunks: SourceChunk[]): void {
    for (const chunk of chunks) {
      const value = chunkRef(chunk);
      if (value?.name === name && kinds.has(value.kind)) {
        targets.push({ path: file.path, chunk: value });
      }
      visit(chunk.children);
    }
  }
  visit(file.result.chunks);
  return targets;
}

/** A chunk that a call can resolve to. */
export function isCallable(chunk: SourceChunkRef): boolean {
  return chunk.kind === "function" || chunk.kind === "method";
}

export function uniqueTarget(candidates: ResolvedTarget[]): ResolvedTarget | null {
  const unique = new Map(
    candidates.map((candidate) => [
      `${candidate.path}\0${candidate.chunk.startOffset}\0${candidate.chunk.endOffset}`,
      candidate,
    ]),
  );
  return unique.size === 1 ? unique.values().next().value! : null;
}

