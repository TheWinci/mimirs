/** Tree-sitter entity query. Captures: @item = entity node,
 *  @name = identifier, @context = signature parts. */
export const ENTITY_QUERY = `
(function_definition) @item
(declaration declarator: (_) @context) @item
(field_declaration) @item

(class_specifier name: (type_identifier) @name body: (field_declaration_list)) @item
(struct_specifier name: (type_identifier) @name body: (field_declaration_list)) @item
(enum_specifier name: (type_identifier) @name body: (enumerator_list)) @item
(union_specifier name: (type_identifier) @name body: (field_declaration_list)) @item
(enumerator name: (identifier) @name) @item

(namespace_definition) @item
(namespace_alias_definition name: (namespace_identifier) @name) @item
(using_declaration) @item
(alias_declaration name: (type_identifier) @name) @item
(type_definition) @item
(template_declaration) @item

(preproc_include) @item
(preproc_def name: (identifier) @name) @item
(preproc_function_def name: (identifier) @name) @item
(preproc_ifdef name: (identifier) @name) @item
(preproc_if condition: (_) @name) @item
(preproc_elif condition: (_) @name) @item
(preproc_else) @item
(preproc_call) @item
`;

/** Identifier capture query. Captures every identifier-like node as
 *  @ref. Filtering happens in the chunker, not here. */
export const REFERENCE_QUERY = `
[
  (identifier)
  (type_identifier)
  (field_identifier)
  (namespace_identifier)
] @ref
`;
