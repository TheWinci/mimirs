//! Computed declaration names that cannot be expressed by one query capture.
use super::text;
use tree_sitter::Node;

pub(super) fn word(source: &str, target: &str) -> bool {
    source
        .split(|c: char| !c.is_alphanumeric() && c != '_')
        .any(|s| s == target)
}

pub(super) fn scala_parameter_is_field(node: Node<'_>, source: &str) -> bool {
    if word(text(node, source), "val") || word(text(node, source), "var") {
        return true;
    }
    node.parent().and_then(|p| p.parent()).is_some_and(|p| {
        p.kind() == "full_enum_case"
            || (p.kind() == "class_definition"
                && p.children(&mut p.walk()).any(|n| n.kind() == "case"))
    })
}

pub(super) fn scala(node: Node<'_>, source: &str) -> Option<String> {
    match node.kind() {
        "given_definition" => Some(
            node.child_by_field_name("name")
                .or_else(|| node.child_by_field_name("return_type"))
                .map_or("(anonymous given)", |n| text(n, source))
                .into(),
        ),
        "extension_definition" => {
            let ty = node
                .child_by_field_name("parameters")
                .and_then(|p| {
                    p.named_children(&mut p.walk())
                        .find(|n| n.kind() == "parameter")
                })
                .and_then(|n| n.child_by_field_name("type"));
            Some(ty.map_or_else(
                || "extensions".into(),
                |n| format!("{} extensions", text(n, source)),
            ))
        }
        _ => None,
    }
}

pub(super) fn php(node: Node<'_>, source: &str) -> Option<String> {
    match node.kind() {
        "namespace_definition" => Some(
            node.child_by_field_name("name")
                .map_or("(global)", |n| text(n, source))
                .into(),
        ),
        "property_declaration" | "const_declaration" => {
            let property = node.kind() == "property_declaration";
            let names: Vec<_> = node
                .named_children(&mut node.walk())
                .filter(|n| {
                    n.kind()
                        == if property {
                            "property_element"
                        } else {
                            "const_element"
                        }
                })
                .filter_map(|n| {
                    if property {
                        n.child_by_field_name("name")
                    } else {
                        n.named_child(0)
                    }
                })
                .map(|n| text(n, source).strip_prefix('$').unwrap_or(text(n, source)))
                .collect();
            (!names.is_empty()).then(|| names.join(", "))
        }
        "property_promotion_parameter" | "assignment_expression" => node
            .child_by_field_name(if node.kind() == "assignment_expression" {
                "left"
            } else {
                "name"
            })
            .map(|n| {
                text(n, source)
                    .strip_prefix('$')
                    .unwrap_or(text(n, source))
                    .into()
            }),
        _ => None,
    }
}

pub(super) fn csharp(node: Node<'_>, source: &str) -> Option<String> {
    match node.kind() {
        "field_declaration" | "event_field_declaration" => {
            let declaration = node
                .named_children(&mut node.walk())
                .find(|n| n.kind() == "variable_declaration")?;
            let names: Vec<_> = declaration
                .named_children(&mut declaration.walk())
                .filter(|n| n.kind() == "variable_declarator")
                .filter_map(|n| n.child_by_field_name("name"))
                .map(|n| text(n, source))
                .collect();
            (!names.is_empty()).then(|| names.join(", "))
        }
        "indexer_declaration" => Some("this".into()),
        "operator_declaration" => Some(
            node.children(&mut node.walk())
                .find(|n| n.kind() == "operator")
                .and_then(|n| n.next_sibling())
                .map_or_else(
                    || "operator".into(),
                    |n| format!("operator {}", text(n, source)),
                ),
        ),
        "conversion_operator_declaration" => {
            let style = node
                .children(&mut node.walk())
                .find(|n| matches!(n.kind(), "implicit" | "explicit"));
            let ty = node.child_by_field_name("type").or_else(|| {
                node.named_children(&mut node.walk())
                    .find(|n| n.kind() != "modifier")
            });
            Some(format!(
                "{} operator {}",
                style.map_or("conversion", |n| text(n, source)),
                ty.map_or("?", |n| text(n, source))
            ))
        }
        _ => None,
    }
}
