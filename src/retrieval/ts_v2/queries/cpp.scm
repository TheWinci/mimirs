; TS v2 122674c8bfbbc3549390743f51396c5f0e4e3537

(function_definition) @item
(declaration declarator: (_) @context) @item
(field_declaration) @item

(class_specifier name: (type_identifier) @name body: (field_declaration_list)) @item
(struct_specifier name: (type_identifier) @name body: (field_declaration_list)) @item
(enum_specifier name: (type_identifier) @name body: (enumerator_list)) @item
(union_specifier name: (type_identifier) @name body: (field_declaration_list)) @item
(enumerator name: (identifier) @name) @item

(namespace_definition) @item
(namespace_alias_definition name: (namespace_identifier) @name) @item
(using_declaration) @item
(alias_declaration name: (type_identifier) @name) @item
(type_definition) @item
(template_declaration) @item

(preproc_include) @item
(preproc_def name: (identifier) @name) @item
(preproc_function_def name: (identifier) @name) @item
(preproc_ifdef name: (identifier) @name) @item
(preproc_if condition: (_) @name) @item
(preproc_elif condition: (_) @name) @item
(preproc_else) @item
(preproc_call) @item
