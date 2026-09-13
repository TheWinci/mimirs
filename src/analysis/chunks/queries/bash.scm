; TS v2 122674c8bfbbc3549390743f51396c5f0e4e3537

(function_definition name: (word) @name) @item
(variable_assignment name: (variable_name) @name) @item

(command
  name: (command_name (word) @context)
  argument: [
    (word)
    (raw_string)
    (string (string_content))
  ]
  (#match? @context "^(source|\.)$")) @item
