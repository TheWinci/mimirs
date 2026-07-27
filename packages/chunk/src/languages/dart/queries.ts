/** Tree-sitter entity query. Captures: @item = entity node,
 *  @name = identifier, @context = signature parts. */
export const ENTITY_QUERY = `
(library_name (dotted_identifier_list) @name) @item
(part_directive) @item
(part_of_directive) @item

(class_definition name: (identifier) @name) @item
(class_definition (mixin_application_class (identifier) @name)) @item
(enum_declaration name: (identifier) @name) @item
(mixin_declaration (identifier) @name) @item
(extension_declaration) @item
(extension_type_declaration name: (identifier) @name) @item
(type_alias (type_identifier) @name) @item
(enum_constant name: (identifier) @name) @item

(method_signature) @item
(declaration (constructor_signature)) @item
(declaration (initialized_identifier_list)) @item

(program (function_signature name: (identifier) @name) @item)
(program (static_final_declaration_list) @item)
(program (initialized_identifier_list) @item)
(local_variable_declaration) @item
(local_function_declaration) @item

(import_or_export) @item
`;

/** Identifier capture query. Captures every identifier-like node as
 *  @ref. Filtering happens in the chunker, not here. */
export const REFERENCE_QUERY = `(identifier) @ref`;
