/** Tree-sitter entity query. Captures: @item = entity node,
 *  @name = identifier, @context = signature parts. */
export const ENTITY_QUERY = `
(class_declaration name: (identifier) @name) @item
(interface_declaration name: (identifier) @name) @item
(struct_declaration name: (identifier) @name) @item
(enum_declaration name: (identifier) @name) @item
(record_declaration name: (identifier) @name) @item
(namespace_declaration name: (_) @name) @item
(file_scoped_namespace_declaration name: (_) @name) @item

(method_declaration name: (identifier) @name) @item
(constructor_declaration name: (identifier) @name) @item
(destructor_declaration name: (identifier) @name) @item
(local_function_statement name: (identifier) @name) @item
(property_declaration name: (identifier) @name) @item
(indexer_declaration) @item
(operator_declaration) @item
(conversion_operator_declaration) @item
(field_declaration) @item
(event_field_declaration) @item
(event_declaration name: (identifier) @name) @item
(delegate_declaration name: (identifier) @name) @item
(enum_member_declaration name: (identifier) @name) @item

(record_declaration
  (parameter_list
    (parameter name: (identifier) @name) @item))

(local_declaration_statement
  (variable_declaration
    (variable_declarator
      name: (identifier) @name
      (lambda_expression)) @item))

(using_directive) @item
`;

/** Identifier capture query. Captures every identifier-like node as
 *  @ref. Filtering happens in the chunker, not here. */
export const REFERENCE_QUERY = `(identifier) @ref`;
