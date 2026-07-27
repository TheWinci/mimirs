import type { SourceChunk, SourceFact } from "../../types";

/**
 * Plain text has no language-level module or call semantics. Code-looking
 * prose, paths, and URLs stay text until a format-specific analyzer opts in.
 */
export function extractTextFacts(
  _source: string,
  _chunks: SourceChunk[],
  _starts: number[],
): SourceFact[] {
  return [];
}
