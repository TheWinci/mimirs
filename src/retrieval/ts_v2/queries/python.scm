; Active TS v2 entity query, reference 122674c8bfbbc3549390743f51396c5f0e4e3537

(decorator) @annotation
(module
  . (expression_statement
      [(string)
       (parenthesized_expression (string))]) @item @docstring)
(block
  . (expression_statement
      [(string)
       (parenthesized_expression (string))]) @item @docstring)
(class_definition name: (identifier) @name) @item
(function_definition name: (identifier) @name) @item
(import_statement) @item
(import_from_statement) @item

(class_definition
  body: (block
    (expression_statement
      (assignment left: (identifier) @name)) @item))

(module
  (expression_statement
    (assignment left: (identifier) @name)) @item)
