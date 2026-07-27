import type { Tree } from "web-tree-sitter";
import type { SourceChunk, SourceFact } from "../../types";

/**
 * YAML serializes data and defines no executable calls or module loading.
 * Schema-specific meanings for keys, tags, and scalar values belong to a
 * future tool-aware layer rather than the language-level extractor.
 */
export function extractYamlFacts(
  _tree: Tree,
  _chunks: SourceChunk[],
  _starts: number[],
): SourceFact[] {
  return [];
}
