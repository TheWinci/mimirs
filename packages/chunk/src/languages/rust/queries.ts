/** Tree-sitter entity query. Captures: @item = entity node,
 *  @name = identifier, @context = signature parts. */
export const ENTITY_QUERY = `
(struct_item name: (type_identifier) @name) @item
(union_item name: (type_identifier) @name) @item
(field_declaration name: (field_identifier) @name) @item
(enum_item name: (type_identifier) @name) @item
(enum_variant name: (identifier) @name) @item
(trait_item name: (type_identifier) @name) @item
(impl_item type: (_) @name) @item
(function_item name: (identifier) @name) @item
(function_signature_item name: (identifier) @name) @item
(mod_item name: (identifier) @name) @item
(type_item name: (type_identifier) @name) @item
(const_item name: (identifier) @name) @item
(static_item name: (identifier) @name) @item
(macro_definition name: (identifier) @name) @item
(let_declaration
  pattern: (identifier) @name
  value: (closure_expression)) @item
(use_declaration) @item
(extern_crate_declaration) @item
`;

/** Identifier capture query. Captures every identifier-like node as
 *  @ref. Filtering happens in the chunker, not here. */
export const REFERENCE_QUERY = `
[
  (identifier)
  (type_identifier)
  (field_identifier)
  (shorthand_field_identifier)
] @ref
`;
