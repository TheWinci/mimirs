/** Tree-sitter entity query. Captures: @item = entity node,
 *  @name = identifier, @context = signature parts. */
export const ENTITY_QUERY = `
(call
  target: (identifier) @context
  (arguments (alias) @name)
  (#match? @context "^(defmodule|defprotocol|defimpl)$")) @item

(call
  target: (identifier) @context
  (arguments
    (call target: (identifier) @name))
  (#match? @context "^(def|defp|defmacro|defmacrop|defguard|defguardp|defdelegate)$")) @item

(call
  target: (identifier) @context
  (arguments (identifier) @name)
  (#match? @context "^(def|defp|defmacro|defmacrop|defguard|defguardp|defdelegate)$")) @item

(call
  target: (identifier) @context
  (arguments
    (binary_operator
      left: (call target: (identifier) @name)
      operator: "when"))
  (#match? @context "^(def|defp|defmacro|defmacrop|defguard|defguardp|defdelegate)$")) @item

(call
  target: (identifier) @context
  (#eq? @context "defstruct")) @item

(unary_operator
  operator: "@"
  operand: (call
    target: (identifier) @context
    (arguments
      (binary_operator
        left: (_) @name
        operator: "::")))
  (#match? @context "^(type|typep|opaque|callback|macrocallback)$")) @item

(binary_operator
  left: (identifier) @name
  operator: "="
  right: (anonymous_function)) @item

(call
  target: (identifier) @context
  (#match? @context "^(import|alias|use|require)$")) @item
`;

/** Identifier capture query. Captures every identifier-like node as
 *  @ref. Filtering happens in the chunker, not here. */
export const REFERENCE_QUERY = `
[
  (identifier)
  (alias)
] @ref
`;
