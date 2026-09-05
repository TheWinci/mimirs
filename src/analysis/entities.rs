use super::Span;
use tree_sitter::Node;

#[derive(Debug, PartialEq, Eq)]
pub struct Entity {
    pub kind: String,
    pub name: Option<String>,
    pub span: Span,
}

pub(super) fn kind(node: Node<'_>) -> Option<&'static str> {
    Some(match node.kind() {
        "function_item" | "function_signature_item" => "function",
        "struct_item" => "struct",
        "union_item" => "union",
        "field_declaration" => "field",
        "enum_item" => "enum",
        "enum_variant" => "variant",
        "trait_item" => "trait",
        "impl_item" => "impl",
        "mod_item" => "module",
        "type_item" | "associated_type" => "type",
        "const_item" => "const",
        "static_item" => "static",
        "macro_definition" => "macro",
        _ if node.parent().is_some_and(|p| {
            p.kind() == "ordered_field_declaration_list"
                && (0..p.child_count())
                    .any(|i| p.child(i) == Some(node) && p.field_name_for_child(i) == Some("type"))
        }) =>
        {
            "field"
        }
        _ => return None,
    })
}

pub(super) fn spelling(node: Node<'_>, source: &str) -> Option<String> {
    (!node.is_missing()).then(|| source[node.byte_range()].to_owned())
}

pub(super) fn extract(root: Node<'_>, source: &str) -> Vec<Entity> {
    let mut entities = Vec::new();
    let mut stack = vec![root];
    while let Some(node) = stack.pop() {
        if let Some(kind) = kind(node) {
            let name = if kind == "impl" {
                node.child_by_field_name("type")
                    .and_then(|n| spelling(n, source))
                    .map(|ty| {
                        node.child_by_field_name("trait")
                            .and_then(|n| spelling(n, source))
                            .map_or(ty.clone(), |tr| format!("{tr} for {ty}"))
                    })
            } else {
                node.child_by_field_name("name")
                    .and_then(|n| spelling(n, source))
            };
            entities.push(Entity {
                kind: kind.into(),
                name,
                span: Span::of(node, source),
            });
        }
        if matches!(node.kind(), "macro_definition" | "token_tree") {
            continue;
        }
        let mut cursor = node.walk();
        let children: Vec<_> = node.named_children(&mut cursor).collect();
        stack.extend(children.into_iter().rev());
    }
    entities
}
