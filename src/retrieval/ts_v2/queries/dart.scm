; TS v2 122674c8bfbbc3549390743f51396c5f0e4e3537

(library_name (dotted_identifier_list) @name) @item
(part_directive) @item
(part_of_directive) @item

(class_definition name: (identifier) @name) @item
(class_definition (mixin_application_class (identifier) @name)) @item
(enum_declaration name: (identifier) @name) @item
(mixin_declaration (identifier) @name) @item
(extension_declaration) @item
(extension_type_declaration name: (identifier) @name) @item
(type_alias (type_identifier) @name) @item
(enum_constant name: (identifier) @name) @item

(method_signature) @item
(declaration (constructor_signature)) @item
(declaration (initialized_identifier_list)) @item

(program (function_signature name: (identifier) @name) @item)
(program (static_final_declaration_list) @item)
(program (initialized_identifier_list) @item)
(local_variable_declaration) @item
(local_function_declaration) @item

(import_or_export) @item
