use super::{Entity, Fact, Scope, Span, facts};
use tree_sitter::Node;

pub(super) fn extract(
    nodes: &[Node<'_>],
    source: &str,
    entities: &[Entity],
    lines: &super::LineIndex,
) -> (Vec<Scope>, Vec<Fact>) {
    let mut scopes = vec![Scope {
        kind: "file".into(),
        span: lines.span(0, source.len()),
        parent: None,
        owner: None,
    }];
    for &node in nodes {
        let kind = if super::entities::kind(node).is_some() {
            Some("item")
        } else {
            match node.kind() {
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
            let span = lines.span(node.start_byte(), end);
            let mut parent = Some(scopes.len() - 1);
            while let Some(id) = parent {
                let candidate = &scopes[id];
                if candidate.span.start <= span.start && candidate.span.end >= span.end {
                    break;
                }
                parent = candidate.parent;
            }
            scopes.push(Scope {
                kind: kind.into(),
                span,
                parent,
                owner: facts::owner(node, entities),
            });
        }
    }
    let mut bindings = Vec::new();
    for &node in nodes {
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
            let pattern = if pattern.kind() == "match_pattern" {
                pattern
                    .named_child(0)
                    .filter(|n| Some(*n) != pattern.child_by_field_name("condition"))
                    .unwrap_or(pattern)
            } else {
                pattern
            };
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
                    fact.add("declaration", Some(node), source);
                    if matches!(role, "let" | "conditional") {
                        fact.add("initializer", node.child_by_field_name("value"), source);
                    }
                    if role == "for" {
                        fact.add("iterable", node.child_by_field_name("value"), source);
                    }
                    fact.add(
                        "alternative",
                        node.child_by_field_name("alternative"),
                        source,
                    );
                    if role == "let"
                        && let Some(value) = node
                            .child_by_field_name("value")
                            .filter(|n| n.kind() == "closure_expression")
                    {
                        fact.add("closure_initializer", Some(value), source);
                    }
                    let mut ancestor = Some(part);
                    while let Some(pattern_node) = ancestor {
                        let mut cursor = pattern_node.walk();
                        for marker in pattern_node
                            .children(&mut cursor)
                            .filter(|n| matches!(n.kind(), "mutable_specifier" | "ref" | "&"))
                        {
                            fact.add("marker", Some(marker), source);
                        }
                        if pattern_node == pattern {
                            break;
                        }
                        ancestor = pattern_node.parent();
                    }
                    // `mut` on a let declaration is a sibling of its pattern.
                    let mut cursor = node.walk();
                    for marker in node
                        .children(&mut cursor)
                        .filter(|n| matches!(n.kind(), "mutable_specifier" | "ref" | "&"))
                    {
                        fact.add("marker", Some(marker), source);
                    }
                    fact.evidence
                        .sort_by_key(|e| (e.span.start, e.span.end, e.role.clone()));
                    fact.evidence.dedup();
                    bindings.push(fact);
                    continue;
                }
                let mut cursor = part.walk();
                let children: Vec<_> = part
                    .named_children(&mut cursor)
                    .filter(|child| {
                        child.kind() == "shorthand_field_identifier"
                            || !["type", "name", "field", "condition"]
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
    let end = scopes.partition_point(|s| s.span.start <= span.start);
    scopes[..end]
        .iter()
        .rposition(|s| s.span.start <= span.start && s.span.end >= span.end)
        .unwrap_or(0)
}
