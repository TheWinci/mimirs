/** Tree-sitter entity query. Captures: @item = entity node,
 *  @name = identifier, @context = signature parts. */
export const ENTITY_QUERY = `
(header module: (module) @name) @item

(function name: (variable) @name) @item
(signature name: (variable) @name) @item
(bind name: (variable) @name) @item

(data_type name: (_) @name) @item
(newtype name: (_) @name) @item
(type_synomym name: (_) @name) @item

(class name: (name) @name) @item
(instance name: (name) @name patterns: (type_patterns) @context) @item

(import) @item
`;

/** Identifier capture query. Captures every identifier-like node as
 *  @ref. Filtering happens in the chunker, not here. */
export const REFERENCE_QUERY = `
[
  (variable)
  (constructor)
] @ref
`;
