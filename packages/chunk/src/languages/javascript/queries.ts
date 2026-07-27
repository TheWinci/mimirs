/** Tree-sitter entity query. Captures: @item = entity node,
 *  @name = identifier, @context = signature parts. */
export const ENTITY_QUERY = `
(export_statement
  "default" @context
  (function_expression) @item @default_export)

(export_statement
  "default" @context
  (class) @item @default_export)

(function_declaration
  "async"? @context "function" @context name: (identifier) @name
  parameters: (formal_parameters "(" @context ")" @context)) @item

(generator_function_declaration
  "async"? @context "function" @context "*" @context name: (identifier) @name
  parameters: (formal_parameters "(" @context ")" @context)) @item

(class_declaration "class" @context name: (identifier) @name) @item

(class_body
  (method_definition
    ["get" "set" "async" "*" "static"]* @context
    name: (_) @name
    parameters: (formal_parameters "(" @context ")" @context)) @item)

(class_body
  (field_definition
    property: (_) @name) @item)

(export_statement
  (lexical_declaration ["let" "const"] @context
    (variable_declarator name: (identifier) @name) @item))

(program
  (lexical_declaration ["let" "const"] @context
    (variable_declarator name: (identifier) @name) @item))

(export_statement
  (lexical_declaration ["let" "const"] @context
    (variable_declarator name: (identifier) @name value: (arrow_function)) @item))

(program
  (lexical_declaration ["let" "const"] @context
    (variable_declarator name: (identifier) @name value: (arrow_function)) @item))

(lexical_declaration ["let" "const"] @context
  (variable_declarator name: (identifier) @name value: (arrow_function)) @item)

(lexical_declaration ["let" "const"] @context
  (variable_declarator name: (identifier) @name value: (function_expression)) @item)

(lexical_declaration ["let" "const"] @context
  (variable_declarator name: [(object_pattern) (array_pattern)] @name) @item)

(import_statement) @item
(export_statement (export_clause)) @item
(export_statement (namespace_export (identifier) @name)) @item
(export_statement "*" @context) @item
`;

/** Identifier capture query. Captures every identifier-like node as
 *  @ref. Filtering happens in the chunker, not here. */
export const REFERENCE_QUERY = `
[
  (identifier)
  (property_identifier)
  (shorthand_property_identifier)
] @ref
`;
