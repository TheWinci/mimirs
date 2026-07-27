/** Tree-sitter entity query. Captures: @item = entity node,
 *  @name = identifier, @context = signature parts. */
export const ENTITY_QUERY = `
(decorator) @annotation
(module
  . (expression_statement
      [(string)
       (parenthesized_expression (string))]) @item @docstring)
(block
  . (expression_statement
      [(string)
       (parenthesized_expression (string))]) @item @docstring)
(class_definition name: (identifier) @name) @item
(function_definition name: (identifier) @name) @item
(import_statement) @item
(import_from_statement) @item

(class_definition
  body: (block
    (expression_statement
      (assignment left: (identifier) @name)) @item))

(module
  (expression_statement
    (assignment left: (identifier) @name)) @item)
`;

/** Identifier capture query. Captures every identifier-like node as
 *  @ref. Filtering happens in the chunker, not here. */
export const REFERENCE_QUERY = `(identifier) @ref`;
