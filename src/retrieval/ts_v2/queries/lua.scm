; TS v2 122674c8bfbbc3549390743f51396c5f0e4e3537

(function_declaration name: (_) @name) @item

(variable_declaration
  (assignment_statement
    (variable_list . (_) @name)
    (expression_list . (function_definition)))) @item

(field
  name: (_) @name
  value: (function_definition)) @item

(variable_declaration
  (assignment_statement
    (variable_list . (_) @name))) @item

(variable_declaration
  (variable_list . (_) @name)) @item

(chunk
  (assignment_statement
    (variable_list . (_) @name)) @item)
