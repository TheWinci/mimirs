/** Tree-sitter entity query. Captures: @item = entity node,
 *  @name = identifier, @context = signature parts. */
export const ENTITY_QUERY = `
(function_declaration name: (identifier) @name) @item

(variable_declaration (identifier) @name) @item

(container_field name: (identifier) @name) @item
(error_set_declaration (identifier) @name @item)

(test_declaration (string) @name) @item
(test_declaration) @item
(comptime_declaration) @item
(using_namespace_declaration) @item
`;

/** Identifier capture query. Captures every identifier-like node as
 *  @ref. Filtering happens in the chunker, not here. */
export const REFERENCE_QUERY = `(identifier) @ref`;
