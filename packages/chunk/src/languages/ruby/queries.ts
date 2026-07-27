/** Tree-sitter entity query. Captures: @item = entity node,
 *  @name = identifier, @context = signature parts. */
export const ENTITY_QUERY = `
(class name: (_) @name) @item
(module name: (_) @name) @item
(singleton_class value: (_) @name) @item
(method name: (_) @name) @item
(singleton_method name: (_) @name) @item

(assignment left: (constant) @name) @item
(assignment
  left: (identifier) @name
  right: (lambda)) @item
`;

/** Identifier capture query. Captures every identifier-like node as
 *  @ref. Filtering happens in the chunker, not here. */
export const REFERENCE_QUERY = `
[
  (identifier)
  (constant)
] @ref
`;
