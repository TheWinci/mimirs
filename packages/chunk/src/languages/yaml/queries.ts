/** Tree-sitter entity query. Captures: @item = entity node,
 *  @name = identifier, @context = signature parts. */
export const ENTITY_QUERY = `
(document) @item
(yaml_directive) @item
(tag_directive) @item
(reserved_directive) @item
(block_mapping_pair
  key: (_) @name) @item
(flow_pair
  key: (_) @name) @item
(block_sequence_item) @item
`;

/** Identifier capture query. Captures every identifier-like node as
 *  @ref. Filtering happens in the chunker, not here. */
export const REFERENCE_QUERY = "";
