; TS v2 122674c8bfbbc3549390743f51396c5f0e4e3537

(class_declaration name: (name) @name) @item
(interface_declaration name: (name) @name) @item
(trait_declaration name: (name) @name) @item
(enum_declaration name: (name) @name) @item

(function_definition name: (name) @name) @item
(method_declaration name: (name) @name) @item

(namespace_definition) @item
(namespace_use_declaration) @item

(property_declaration) @item
(const_declaration) @item
(enum_case name: (name) @name) @item
(method_declaration
  parameters: (formal_parameters
    (property_promotion_parameter
      name: (variable_name) @name) @item))

(assignment_expression
  left: (variable_name) @name
  right: [(arrow_function) (anonymous_function)]) @item

(require_expression) @item
(require_once_expression) @item
(include_expression) @item
(include_once_expression) @item
