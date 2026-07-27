/** Tree-sitter entity query. Captures: @item = entity node,
 *  @name = identifier, @context = signature parts. */
export const ENTITY_QUERY = `
(class_definition name: (identifier) @name) @item
(object_definition name: (identifier) @name) @item
(trait_definition name: (identifier) @name) @item
(package_object name: (identifier) @name) @item
(enum_definition name: (identifier) @name) @item
(given_definition) @item
(extension_definition) @item
(type_definition name: (type_identifier) @name) @item

(function_definition name: (identifier) @name) @item
(function_declaration name: (identifier) @name) @item

(simple_enum_case name: (identifier) @name) @item
(full_enum_case name: (identifier) @name) @item
(class_parameter name: (identifier) @name) @item
(val_definition pattern: (identifier) @name) @item
(var_definition pattern: (identifier) @name) @item

(import_declaration) @item
(package_clause name: (package_identifier) @name) @item
`;

/** Identifier capture query. Captures every identifier-like node as
 *  @ref. Filtering happens in the chunker, not here. */
export const REFERENCE_QUERY = `(identifier) @ref`;
