/**
 * Utilities for the usages feature.
 *
 * usages works at query time rather than pre-indexing call sites:
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

/**
 * Sanitize a user query for FTS5 MATCH by quoting each token.
 * FTS5 treats bare +, -, *, AND, OR, NOT, NEAR, ( ) as operators.
 * Wrapping each token in double quotes forces literal matching.
 *
 * Tokens are joined with OR, not the implicit AND of space-joining. With AND,
 * any query of more than ~2-3 distinct terms requires all of them to co-occur
 * in a single chunk and so matches nothing — which silently disabled BM25 for
 * realistic multi-word/NL queries (collapsing hybrid search to vector-only).
 * OR lets BM25 rank candidates by how many/which terms they match.
 */
export function sanitizeFTS(query: string): string {
  const tokens = query.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return '""';
  return tokens.map(t => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}
