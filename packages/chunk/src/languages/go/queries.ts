/** Tree-sitter entity query. Captures: @item = entity node,
 *  @name = identifier, @context = signature parts. */
export const ENTITY_QUERY = `
(comment) @annotation

(type_declaration "type" @context
  [(type_spec name: (_) @name) @item
   ("(" (type_spec name: (_) @name) @item ")")])

(function_declaration "func" @context name: (identifier) @name
  parameters: (parameter_list "(" ")")) @item

(method_declaration "func" @context
  receiver: (parameter_list
    "(" @context (parameter_declaration) @context ")" @context)
  name: (field_identifier) @name
  parameters: (parameter_list "(" ")")) @item

(const_declaration "const" @context
  (const_spec name: (identifier) @name) @item)

((const_declaration) @item
  (#match? @item "^const\\\\s*[(]"))

((var_declaration) @item
  (#match? @item "^var\\\\s*[(]"))

(source_file
  (var_declaration "var" @context
    [(var_spec name: (identifier) @name) @item
     (var_spec_list (var_spec name: (identifier) @name) @item)]))

(short_var_declaration
  left: (expression_list (identifier) @name)
  right: (expression_list (func_literal))) @item

(var_spec
  name: (identifier) @name
  value: (expression_list (func_literal))) @item

(method_elem name: (_) @name
  parameters: (parameter_list "(" @context ")" @context)) @item

(field_declaration) @item
(import_declaration) @item
(package_clause "package" @context (package_identifier) @name) @item
`;

/** Identifier capture query. Captures every identifier-like node as
 *  @ref. Filtering happens in the chunker, not here. */
export const REFERENCE_QUERY = `
[
  (identifier)
  (field_identifier)
  (type_identifier)
  (package_identifier)
] @ref
`;
