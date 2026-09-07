//! Dart signatures and binding patterns from the active TS v2 extraction rules.
use super::{contains, kinds::node_kind, text};
use tree_sitter::Node;

fn pattern_names<'a>(node: Node<'_>, source: &'a str, output: &mut Vec<&'a str>) {
    let identifier = match node.kind() {
        "variable_pattern" => node
            .named_children(&mut node.walk())
            .filter(|n| n.kind() == "identifier")
            .last(),
        "constant_pattern" => node
            .named_children(&mut node.walk())
            .find(|n| n.kind() == "identifier"),
        _ => {
            for child in node.named_children(&mut node.walk()) {
                pattern_names(child, source, output);
            }
            return;
        }
    };
    if let Some(identifier) = identifier {
        output.push(text(identifier, source));
    }
}

fn binding_names<'a>(node: Node<'_>, source: &'a str, output: &mut Vec<&'a str>) {
    let identifier = match node.kind() {
        "static_final_declaration" | "initialized_identifier" => node
            .named_children(&mut node.walk())
            .find(|n| n.kind() == "identifier"),
        "initialized_variable_definition" => node.child_by_field_name("name"),
        "pattern_variable_declaration" => {
            if let Some(pattern) = node
                .named_children(&mut node.walk())
                .find(|n| n.kind().ends_with("_pattern"))
            {
                pattern_names(pattern, source, output);
            }
            return;
        }
        _ => {
            for child in node.named_children(&mut node.walk()) {
                binding_names(child, source, output);
            }
            return;
        }
    };
    if let Some(identifier) = identifier {
        output.push(text(identifier, source));
    }
}

fn signature(node: Node<'_>, source: &str) -> Option<String> {
    let node = if node.kind() == "method_signature" {
        node.named_child(0)?
    } else {
        node
    };
    if matches!(
        node.kind(),
        "constructor_signature" | "factory_constructor_signature"
    ) {
        let end = node
            .named_children(&mut node.walk())
            .find(|n| n.kind() == "formal_parameter_list")
            .map_or(node.end_byte(), |n| n.start_byte());
        let names: Vec<_> = node
            .named_children(&mut node.walk())
            .filter(|n| n.kind() == "identifier" && n.end_byte() <= end)
            .map(|n| text(n, source))
            .collect();
        return (!names.is_empty()).then(|| names.join("."));
    }
    node.child_by_field_name("name")
        .map(|n| text(n, source).into())
        .or_else(|| {
            node.named_children(&mut node.walk())
                .find_map(|n| signature(n, source))
        })
}

pub(super) fn name(node: Node<'_>, source: &str) -> Option<String> {
    match node.kind() {
        "part_of_directive" => {
            return node
                .named_children(&mut node.walk())
                .find(|n| n.kind() == "dotted_identifier_list")
                .map(|n| text(n, source).into());
        }
        "extension_declaration" => {
            return Some(node.child_by_field_name("name").map_or_else(
                || {
                    format!(
                        "(extension on {})",
                        node.child_by_field_name("class")
                            .map_or("?", |n| text(n, source))
                    )
                },
                |n| text(n, source).into(),
            ));
        }
        "method_signature" | "function_signature" => return signature(node, source),
        "declaration" if contains(Some(node), "constructor_signature") => {
            return node
                .named_children(&mut node.walk())
                .find(|n| n.kind() == "constructor_signature")
                .and_then(|n| signature(n, source));
        }
        "local_function_declaration" => {
            return node
                .named_child(0)
                .and_then(|n| {
                    n.named_children(&mut n.walk())
                        .find(|n| n.kind() == "function_signature")
                })
                .and_then(|n| signature(n, source));
        }
        _ => {}
    }
    let mut names = Vec::new();
    binding_names(node, source, &mut names);
    (!names.is_empty()).then(|| names.join(", "))
}

pub(super) fn kind(node: Node<'_>) -> &str {
    if contains(Some(node), "function_expression") {
        return "function";
    }
    if node.kind() == "declaration" {
        return if contains(Some(node), "constructor_signature") {
            "method"
        } else {
            "field"
        };
    }
    if node.kind() == "static_final_declaration_list" {
        let mut previous = node.prev_named_sibling();
        while let Some(n) = previous.filter(|n| n.end_position().row == node.start_position().row) {
            if n.kind() == "const_builtin" {
                return "constant";
            }
            previous = n.prev_named_sibling();
        }
    }
    node_kind(node.kind())
}
