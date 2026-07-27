/** Tree-sitter entity query. Captures: @item = entity node,
 *  @name = identifier, @context = signature parts. */
export const ENTITY_QUERY = `
(export_statement
  "default" @context
  value: (function_expression) @item @default_export)

(export_statement
  "default" @context
  value: (class) @item @default_export)

(internal_module "namespace" @context name: (_) @name) @item
(enum_declaration "enum" @context name: (_) @name) @item
(type_alias_declaration "type" @context name: (_) @name) @item

(function_declaration
  "async"? @context "function" @context name: (_) @name
  parameters: (formal_parameters "(" @context ")" @context)) @item

(function_signature
  name: (_) @name
  parameters: (formal_parameters "(" @context ")" @context)) @item @overload

(generator_function_declaration
  "async"? @context "function" @context "*" @context name: (_) @name
  parameters: (formal_parameters "(" @context ")" @context)) @item

(interface_declaration "interface" @context name: (_) @name) @item

(export_statement
  (lexical_declaration ["let" "const"] @context
    (variable_declarator name: (identifier) @name) @item))

(program
  (lexical_declaration ["let" "const"] @context
    (variable_declarator name: (identifier) @name) @item))

(class_declaration "class" @context name: (_) @name) @item
(abstract_class_declaration "abstract" @context "class" @context name: (_) @name) @item

(class_body
  (method_definition
    ["get" "set" "async" "*" "readonly" "static" (override_modifier) (accessibility_modifier)]* @context
    name: (_) @name
    parameters: (formal_parameters "(" @context ")" @context)) @item)

(class_body
  (abstract_method_signature
    name: (_) @name
    parameters: (formal_parameters "(" @context ")" @context)) @item @overload)

(method_signature
  name: (_) @name
  parameters: (formal_parameters "(" @context ")" @context)) @item @overload

(interface_body
  (property_signature name: (_) @name) @item)

(public_field_definition
  ["declare" "readonly" "abstract" "static" (accessibility_modifier)]* @context
  name: (_) @name) @item

(export_statement
  (lexical_declaration ["let" "const"] @context
    (variable_declarator name: (identifier) @name value: (arrow_function)) @item))

(program
  (lexical_declaration ["let" "const"] @context
    (variable_declarator name: (identifier) @name value: (arrow_function)) @item))

(lexical_declaration ["let" "const"] @context
  (variable_declarator name: (identifier) @name value: (arrow_function)) @item)

(lexical_declaration ["let" "const"] @context
  (variable_declarator name: [(object_pattern) (array_pattern)] @name) @item)

(import_statement) @item
(export_statement (export_clause)) @item
(export_statement "*" @context) @item
`;

/** Identifier capture query. Captures every identifier-like node as
 *  @ref. Filtering happens in the chunker, not here. */
export const REFERENCE_QUERY = `
[
  (identifier)
  (property_identifier)
  (type_identifier)
  (shorthand_property_identifier)
] @ref
`;
