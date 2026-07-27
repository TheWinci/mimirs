/** Tree-sitter entity query. Captures: @item = entity node,
 *  @name = identifier, @context = signature parts. */
export const ENTITY_QUERY = `
(value_definition) @item

(type_definition
  (type_binding name: (type_constructor) @name)) @item

(module_definition
  (module_binding (module_name) @name)) @item
(module_type_definition (module_type_name) @name) @item
(class_definition
  (class_binding (class_name) @name)) @item
(class_type_definition
  (class_type_binding (class_type_name) @name)) @item
(method_definition (method_name) @name) @item
(value_specification (value_name) @name) @item
(method_specification (method_name) @name) @item

(open_module) @item
(include_module) @item
(include_module_type) @item

(external (value_name) @name) @item

(exception_definition
  (constructor_declaration (constructor_name) @name)) @item
`;

/** Identifier capture query. Captures every identifier-like node as
 *  @ref. Filtering happens in the chunker, not here. */
export const REFERENCE_QUERY = `
[
  (value_name)
  (type_constructor)
  (module_name)
] @ref
`;
