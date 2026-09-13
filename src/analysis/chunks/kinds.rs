// TS v2 node kinds, reference 122674c8bfbbc3549390743f51396c5f0e4e3537
pub(super) fn node_kind(node: &str) -> &str {
    match node {
        "function_declaration"
        | "function_signature"
        | "function_expression"
        | "generator_function_declaration"
        | "arrow_function"
        | "function_definition"
        | "decorated_definition"
        | "function_item"
        | "local_function_statement"
        | "test_declaration"
        | "call"
        | "function"
        | "value_definition"
        | "value_specification"
        | "external"
        | "local_function_declaration" => "function",
        "class_declaration"
        | "abstract_class_declaration"
        | "class_definition"
        | "class_specifier"
        | "class"
        | "singleton_class"
        | "object_definition"
        | "object_declaration"
        | "companion_object"
        | "extension_declaration"
        | "extension_type_declaration" => "class",
        "method_definition"
        | "method_signature"
        | "abstract_method_signature"
        | "function_signature_item"
        | "method_declaration"
        | "method_elem"
        | "constructor_declaration"
        | "compact_constructor_declaration"
        | "annotation_type_element_declaration"
        | "destructor_declaration"
        | "operator_declaration"
        | "conversion_operator_declaration"
        | "method"
        | "singleton_method"
        | "secondary_constructor"
        | "method_specification" => "method",
        "interface_declaration" | "class_type_definition" => "interface",
        "type_alias_declaration"
        | "type_item"
        | "type_declaration"
        | "type_spec"
        | "type_definition"
        | "template_declaration"
        | "alias_declaration"
        | "type_alias"
        | "signature"
        | "data_type"
        | "newtype"
        | "type_synomym"
        | "module_type_definition"
        | "exception_definition" => "type",
        "enum_declaration"
        | "enum_item"
        | "enum_specifier"
        | "enum_definition"
        | "error_set_declaration" => "enum",
        "import_statement"
        | "import_from_statement"
        | "use_declaration"
        | "extern_crate_declaration"
        | "import_declaration"
        | "preproc_include"
        | "using_declaration"
        | "using_directive"
        | "namespace_use_declaration"
        | "require_expression"
        | "require_once_expression"
        | "include_expression"
        | "include_once_expression"
        | "import"
        | "using_namespace_declaration"
        | "open_module"
        | "include_module"
        | "include_module_type"
        | "import_or_export"
        | "part_directive" => "import",
        "export_statement" => "export",
        "internal_module"
        | "mod_item"
        | "module_declaration"
        | "namespace_definition"
        | "namespace_alias_definition"
        | "namespace_declaration"
        | "file_scoped_namespace_declaration"
        | "module"
        | "package_object"
        | "module_definition"
        | "library_name"
        | "part_of_directive" => "module",
        "variable_declarator"
        | "lexical_declaration"
        | "expression_statement"
        | "static_item"
        | "let_declaration"
        | "var_declaration"
        | "var_spec"
        | "short_var_declaration"
        | "val_definition"
        | "var_definition"
        | "variable_declaration"
        | "assignment_statement"
        | "variable_assignment"
        | "bind"
        | "static_final_declaration_list"
        | "initialized_identifier_list"
        | "local_variable_declaration" => "variable",
        "field_definition"
        | "public_field_definition"
        | "field_declaration"
        | "formal_parameter"
        | "property_promotion_parameter"
        | "class_parameter"
        | "container_field"
        | "declaration" => "field",
        "property_signature"
        | "property_declaration"
        | "indexer_declaration"
        | "parameter"
        | "block_mapping_pair"
        | "flow_pair"
        | "pair" => "property",
        "struct_item" | "union_item" | "struct_specifier" | "union_specifier"
        | "struct_declaration" => "struct",
        "trait_item" | "trait_declaration" | "trait_definition" | "mixin_declaration" => "trait",
        "impl_item" | "extension_definition" | "instance" => "impl",
        "const_item"
        | "enum_variant"
        | "const_declaration"
        | "const_spec"
        | "enum_constant"
        | "enumerator"
        | "enum_member_declaration"
        | "enum_case"
        | "simple_enum_case"
        | "full_enum_case"
        | "enum_entry" => "constant",
        "macro_definition" | "preproc_def" | "preproc_function_def" => "macro",
        "package_clause" | "package_declaration" | "package_header" => "package",
        "record_declaration" => "record",
        "annotation_type_declaration" => "annotation_type",
        "static_initializer" | "anonymous_initializer" | "comptime_declaration" => "initializer",
        "preproc_ifdef" | "preproc_if" | "preproc_elif" | "preproc_else" => "conditional",
        "preproc_call"
        | "doctype"
        | "namespace_statement"
        | "charset_statement"
        | "yaml_directive"
        | "tag_directive"
        | "reserved_directive" => "directive",
        "event_declaration" | "event_field_declaration" => "event",
        "delegate_declaration" => "delegate",
        "given_definition" => "given",
        "element" | "script_element" | "style_element" => "element",
        "rule_set" => "selector",
        "media_statement"
        | "keyframes_statement"
        | "supports_statement"
        | "scope_statement"
        | "at_rule" => "rule",
        "block_sequence_item" | "document" | "table" | "table_array_element" => "section",
        _ => "block",
    }
}
