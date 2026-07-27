/** Tree-sitter entity query. Captures: @item = entity node,
 *  @name = identifier, @context = signature parts. */
export const ENTITY_QUERY = `
(package_declaration "package" @context (_) @name) @item
(import_declaration) @item
(module_declaration name: (_) @name) @item

(class_declaration (modifiers)? @context "class" @context name: (identifier) @name) @item
(interface_declaration (modifiers)? @context "interface" @context name: (identifier) @name) @item
(record_declaration (modifiers)? @context "record" @context name: (identifier) @name) @item
(enum_declaration (modifiers)? @context "enum" @context name: (identifier) @name) @item
(enum_constant name: (identifier) @name) @item
(annotation_type_declaration (modifiers)? @context "@interface" @context name: (identifier) @name) @item

(method_declaration (modifiers)? @context type: (_) @context name: (identifier) @name
  parameters: (formal_parameters "(" @context ")" @context)) @item

(constructor_declaration (modifiers)? @context name: (identifier) @name
  parameters: (formal_parameters "(" @context ")" @context)) @item

(compact_constructor_declaration (modifiers)? @context name: (identifier) @name) @item

(field_declaration (modifiers)? @context type: (_) @context
  declarator: (variable_declarator name: (identifier) @name)) @item

(record_declaration
  parameters: (formal_parameters
    (formal_parameter name: (identifier) @name) @item))

(local_variable_declaration
  declarator: (variable_declarator
    name: (identifier) @name
    value: (lambda_expression)) @item)

(static_initializer "static" @context) @item
(class_body (block) @item)

(annotation_type_element_declaration type: (_) @context name: (identifier) @name) @item

(class_body
  (class_declaration (modifiers)? @context "class" @context name: (identifier) @name) @item)
(class_body
  (interface_declaration (modifiers)? @context "interface" @context name: (identifier) @name) @item)
(class_body
  (enum_declaration (modifiers)? @context "enum" @context name: (identifier) @name) @item)
`;

/** Identifier capture query. Captures every identifier-like node as
 *  @ref. Filtering happens in the chunker, not here. */
export const REFERENCE_QUERY = `
[
  (identifier)
  (type_identifier)
] @ref
`;
