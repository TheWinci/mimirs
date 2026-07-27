/** Tree-sitter entity query. Captures: @item = entity node,
 *  @name = identifier, @context = signature parts. */
export const ENTITY_QUERY = `
(table (bare_key) @name) @item
(table (quoted_key) @name) @item
(table (dotted_key) @name) @item
(table_array_element (bare_key) @name) @item
(table_array_element (quoted_key) @name) @item
(table_array_element (dotted_key) @name) @item
(pair (bare_key) @name) @item
(pair (quoted_key) @name) @item
(pair (dotted_key) @name) @item
`;

/** Identifier capture query. Captures every identifier-like node as
 *  @ref. Filtering happens in the chunker, not here. */
export const REFERENCE_QUERY = "";
