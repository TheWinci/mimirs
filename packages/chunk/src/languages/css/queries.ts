/** Tree-sitter entity query. Captures: @item = entity node,
 *  @name = identifier, @context = signature parts. */
export const ENTITY_QUERY = `
(rule_set
  (selectors) @name) @item

(media_statement) @item
(supports_statement) @item
(scope_statement) @item
(import_statement) @item
(namespace_statement) @item
(charset_statement) @item
(at_rule
  (at_keyword) @name) @item
(keyframes_statement
  (keyframes_name) @name) @item
`;

/** Identifier capture query. Captures every identifier-like node as
 *  @ref. Filtering happens in the chunker, not here. */
export const REFERENCE_QUERY = "";
