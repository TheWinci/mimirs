/**
 * Identifier-aware tokenization for full-text search.
 *
 * FTS5's default unicode61 tokenizer splits on punctuation/whitespace but NOT on
 * case boundaries, so `getDependsOn` is one opaque token and a search for
 * `depends` cannot match it. We index a companion `parts` column holding each
 * COMPOUND identifier's pieces (camelCase / snake_case / kebab / dotted), so both
 * the whole identifier and its words are searchable. Single plain words are
 * already in the snippet, so we don't repeat them.
 */

/** Split one identifier into its lowercase word parts (≥2 chars). */
export function splitIdentifier(token: string): string[] {
  return token
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")     // fooBar    -> foo Bar
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")  // HTMLParser -> HTML Parser
    .split(/[^A-Za-z0-9]+/)                       // snake_case, kebab, dots, etc.
    .filter((p) => p.length >= 2)
    .map((p) => p.toLowerCase());
}

/**
 * Extract the identifier word-parts from a chunk of text as a space-joined,
 * de-duplicated string for an FTS column. Only emits parts of multi-part
 * identifiers — single words already live in the snippet.
 */
export function identifierParts(text: string): string {
  const out = new Set<string>();
  const tokens = text.match(/[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*/g) || [];
  for (const tok of tokens) {
    const parts = splitIdentifier(tok);
    if (parts.length > 1) for (const p of parts) out.add(p);
  }
  return [...out].join(" ");
}
