/** Tree-sitter entity query. Captures: @item = entity node,
 *  @name = identifier, @context = signature parts. */
export const ENTITY_QUERY = `
(function_definition name: (word) @name) @item
(variable_assignment name: (variable_name) @name) @item

(command
  name: (command_name (word) @context)
  argument: [
    (word)
    (raw_string)
    (string (string_content))
  ]
  (#match? @context "^(source|\\.)$")) @item
`;

/** Identifier capture query. Captures every identifier-like node as
 *  @ref. Filtering happens in the chunker, not here. */
export const REFERENCE_QUERY = `
[
  (variable_name)
  (command_name)
] @ref
`;
