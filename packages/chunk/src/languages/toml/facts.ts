import type { Tree } from "web-tree-sitter";
import type { SourceChunk, SourceFact } from "../../types";

/**
 * TOML defines data, not module loading or executable calls. Tool-specific
 * keys such as `include`, `extends`, and `command` stay ordinary properties;
 * interpreting them here would invent semantics that TOML itself does not
 * provide.
 */
export function extractTomlFacts(
  _tree: Tree,
  _chunks: SourceChunk[],
  _starts: number[],
): SourceFact[] {
  return [];
}
