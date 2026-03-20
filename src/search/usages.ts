/**
 * Utilities for the find_usages feature.
 *
 * find_usages works at query time rather than pre-indexing call sites:
 *   1. FTS search finds chunks containing the symbol name.
 *   2. Defining files are excluded via the file_exports table.
 *   3. Within each matching chunk, a word-boundary regex locates the exact line.
 *   4. Absolute line numbers are computed from the chunk's stored start_line.
 *
 * This avoids a full re-index pass and handles all supported file types since
 * all chunks are in the FTS index regardless of language.
 */

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
