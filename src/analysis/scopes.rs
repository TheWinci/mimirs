use super::{Entity, Fact, Span, facts};
use tree_sitter::Node;

#[derive(Debug, PartialEq, Eq)]
pub struct Scope {
    pub kind: String,
    pub span: Span,
    pub parent: Option<usize>,
    pub owner: Option<usize>,
}

pub(super) fn extract(
    root: Node<'_>,
    source: &str,
    entities: &[Entity],
) -> (Vec<Scope>, Vec<Fact>) {
    let mut scopes = Vec::new();
    for node in facts::nodes(root) {
        let kind = if super::entities::kind(node).is_some() {
            Some("item")
        } else {
            match node.kind() {
                "source_file" => Some("file"),
                "block" => Some("block"),
                "closure_expression" => Some("closure"),
                "match_arm" => Some("match_arm"),
                "for_expression" | "loop_expression" | "while_expression" => Some("loop"),
                "if_expression" => Some("conditional"),
                _ => None,
            }
        };
        if let Some(kind) = kind {
            let end = if kind == "conditional" {
                node.child_by_field_name("consequence")
                    .map_or(node.end_byte(), |n| n.end_byte())
            } else {
                node.end_byte()
            };
            let span = Span::at(source, node.start_byte(), end);
            let parent = scopes
                .iter()
                .rposition(|s: &Scope| s.span.start <= span.start && s.span.end >= span.end);
            scopes.push(Scope {
                kind: kind.into(),
                span,
                parent,
                owner: if kind == "file" {
                    None
                } else {
                    facts::owner(node, entities)
                },
            });
        }
    }
    let mut bindings = Vec::new();
    for node in facts::nodes(root) {
        let role = match node.kind() {
            "parameter" | "self_parameter" => "parameter",
            "let_declaration" => "let",
            "for_expression" => "for",
            "match_arm" => "match",
            "let_condition" => "conditional",
            "closure_parameters" => "closure",
            _ => continue,
        };
        let patterns = if role == "closure" {
            let mut cursor = node.walk();
            node.named_children(&mut cursor)
                .filter(|n| n.kind() != "parameter")
                .collect::<Vec<_>>()
        } else if node.kind() == "self_parameter" {
            vec![node]
        } else {
            node.child_by_field_name("pattern").into_iter().collect()
        };
        for pattern in patterns {
            let mut stack = vec![pattern];
            while let Some(part) = stack.pop() {
                if matches!(
                    part.kind(),
                    "scoped_identifier"
                        | "type_identifier"
                        | "remaining_field_pattern"
                        | "range_pattern"
                ) {
                    continue;
                }
                if matches!(
                    part.kind(),
                    "identifier" | "shorthand_field_identifier" | "self"
                ) && !part.is_missing()
                {
                    let mut fact = Fact::new("binding", part, source, entities);
                    fact.add(role, Some(pattern), source);
                    fact.add("pattern_candidate", Some(part), source);
                    fact.add("initializer", node.child_by_field_name("value"), source);
                    if let Some(value) = node
                        .child_by_field_name("value")
                        .filter(|n| n.kind() == "closure_expression")
                    {
                        fact.add("closure_initializer", Some(value), source);
                    }
                    for pattern_node in facts::nodes(pattern) {
                        let mut cursor = pattern_node.walk();
                        for marker in pattern_node
                            .children(&mut cursor)
                            .filter(|n| matches!(n.kind(), "mutable_specifier" | "ref" | "&"))
                        {
                            fact.add("marker", Some(marker), source);
                        }
                    }
                    // `mut` on a let declaration is a sibling of its pattern.
                    let mut cursor = node.walk();
                    for marker in node
                        .children(&mut cursor)
                        .filter(|n| matches!(n.kind(), "mutable_specifier" | "ref" | "&"))
                    {
                        fact.add("marker", Some(marker), source);
                    }
                    bindings.push(fact);
                    continue;
                }
                let mut cursor = part.walk();
                let children: Vec<_> = part
                    .named_children(&mut cursor)
                    .filter(|child| {
                        !["type", "name", "field", "condition"]
                            .iter()
                            .any(|field| part.child_by_field_name(field) == Some(*child))
                    })
                    .collect();
                stack.extend(children.into_iter().rev());
            }
        }
    }
    (scopes, bindings)
}

pub(super) fn containing(scopes: &[Scope], span: &Span) -> usize {
    scopes
        .iter()
        .rposition(|s| s.span.start <= span.start && s.span.end >= span.end)
        .unwrap_or(0)
}
