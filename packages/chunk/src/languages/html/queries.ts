/** Tree-sitter entity query. Captures: @item = entity node,
 *  @name = identifier, @context = signature parts. */
export const ENTITY_QUERY = `
(element
  (start_tag (tag_name) @name)) @item
(element
  (self_closing_tag (tag_name) @name)) @item
(script_element
  (start_tag (tag_name) @name)) @item
(style_element
  (start_tag (tag_name) @name)) @item
(doctype) @item
`;

/** Identifier capture query. Captures every identifier-like node as
 *  @ref. Filtering happens in the chunker, not here. */
export const REFERENCE_QUERY = "";
