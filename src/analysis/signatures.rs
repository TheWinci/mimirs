use super::{Entity, Fact, Span, facts};
use tree_sitter::Node;

pub(super) fn extract(root: Node<'_>, source: &str, entities: &[Entity]) -> Vec<Fact> {
    let mut output = Vec::new();
    for node in facts::nodes(root) {
        if super::entities::kind(node).is_none() {
            continue;
        }
        let Some(owner) = entities
            .iter()
            .position(|e| e.span.start == node.start_byte() && e.span.end == node.end_byte())
        else {
            continue;
        };
        if entities[owner].kind == "macro" {
            continue;
        }
        let end = node
            .child_by_field_name("body")
            .or_else(|| {
                if matches!(node.kind(), "const_item" | "static_item") {
                    node.child_by_field_name("value")
                } else {
                    None
                }
            })
            .map_or(node.end_byte(), |body| body.start_byte());
        let mut fact = Fact::new("signature", node, source, entities);
        fact.owner = Some(owner);
        fact.span = Span::at(source, node.start_byte(), end);
        let mut stack = vec![node];
        while let Some(part) = stack.pop() {
            if part.start_byte() >= end || part.end_byte() > end && part != node {
                continue;
            }
            if part != node && super::entities::kind(part).is_some() {
                continue;
            }
            let mut cursor = part.walk();
            let children: Vec<_> = part.named_children(&mut cursor).collect();
            for child in &children {
                let field = (0..part.child_count())
                    .find(|&i| part.child(i) == Some(*child))
                    .and_then(|i| part.field_name_for_child(i));
                let role = match child.kind() {
                    "visibility_modifier" => Some("visibility"),
                    "function_modifiers" | "mutable_specifier" => Some("modifiers"),
                    "parameter" => Some("parameter"),
                    "self_parameter" => Some("receiver"),
                    "type_parameters" => Some("generics"),
                    "type_parameter" => Some("type_parameter"),
                    "const_parameter" => Some("const_parameter"),
                    "lifetime_parameter" => Some("lifetime_parameter"),
                    "where_clause" => Some("where"),
                    "trait_bounds" => Some("bounds"),
                    _ => match field {
                        Some("return_type") => Some("return_type"),
                        Some("type") => Some("type"),
                        Some("trait") => Some("trait"),
                        _ => None,
                    },
                };
                if child.end_byte() <= end
                    && let Some(role) = role
                {
                    fact.add(role, Some(*child), source);
                }
                if child.end_byte() <= end
                    && matches!(
                        child.kind(),
                        "type_identifier"
                            | "scoped_type_identifier"
                            | "primitive_type"
                            | "lifetime"
                    )
                    && field != Some("name")
                {
                    fact.add("type_reference", Some(*child), source);
                }
            }
            stack.extend(children.into_iter().rev());
        }
        if entities[owner].kind == "field" && entities[owner].name.is_none() {
            fact.add("type", Some(node), source);
        }
        fact.evidence.sort_by_key(|e| (e.span.start, e.span.end));
        output.push(fact);
    }
    output
}
