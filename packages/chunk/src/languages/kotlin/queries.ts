/** Tree-sitter entity query. Captures: @item = entity node,
 *  @name = identifier, @context = signature parts. */
export const ENTITY_QUERY = `
(package_header (qualified_identifier) @name) @item
(import) @item

(class_declaration name: (identifier) @name) @item
(object_declaration name: (identifier) @name) @item
(companion_object name: (identifier) @name) @item
(companion_object) @item

(function_declaration name: (identifier) @name) @item
(type_alias type: (identifier) @name) @item
(enum_entry (identifier) @name) @item
(secondary_constructor) @item
(anonymous_initializer) @item

(class_parameter (identifier) @name) @item
(property_declaration
  (variable_declaration (identifier) @name)) @item
`;

/** Identifier capture query. Captures every identifier-like node as
 *  @ref. Filtering happens in the chunker, not here. */
export const REFERENCE_QUERY = `(identifier) @ref`;
