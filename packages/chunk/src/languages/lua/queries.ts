/** Tree-sitter entity query. Captures: @item = entity node,
 *  @name = identifier, @context = signature parts. */
export const ENTITY_QUERY = `
(function_declaration name: (_) @name) @item

(variable_declaration
  (assignment_statement
    (variable_list . (_) @name)
    (expression_list . (function_definition)))) @item

(field
  name: (_) @name
  value: (function_definition)) @item

(variable_declaration
  (assignment_statement
    (variable_list . (_) @name))) @item

(variable_declaration
  (variable_list . (_) @name)) @item

(chunk
  (assignment_statement
    (variable_list . (_) @name)) @item)
`;

/** Identifier capture query. Captures every identifier-like node as
 *  @ref. Filtering happens in the chunker, not here. */
export const REFERENCE_QUERY = `(identifier) @ref`;
