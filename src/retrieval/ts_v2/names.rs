//! Computed declaration names that cannot be expressed by one query capture.
use super::text;
use tree_sitter::Node;

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
