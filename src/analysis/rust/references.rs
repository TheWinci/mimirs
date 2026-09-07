use super::{Entity, Fact};
use tree_sitter::Node;

pub(super) fn extract(
    nodes: &[Node<'_>],
    source: &str,
    entities: &[Entity],
    existing: &[Fact],
) -> Vec<Fact> {
    let mut output = Vec::new();
    let mut excluded = Vec::new();
    for fact in existing {
        if matches!(
            fact.kind.as_str(),
            "signature" | "import" | "extern_crate" | "attribute" | "comment" | "doc"
        ) {
            excluded.push((fact.span.start, fact.span.end));
        } else if fact.kind == "binding" {
            excluded.extend(
                fact.evidence
                    .iter()
                    .filter(|e| {
                        matches!(
                            e.role.as_str(),
                            "let" | "parameter" | "closure" | "for" | "match" | "conditional"
                        )
                    })
                    .map(|e| (e.span.start, e.span.end)),
            );
        }
    }
    let excluded = merge_ranges(excluded);
    let is_excluded = |node| covered(node, &excluded);
    for &node in nodes {
        if is_excluded(node) {
            continue;
        }
        if node.kind() == "call_expression" {
            let mut fact = Fact::new("call", node, source, entities);
            if let Some(callee) = node.child_by_field_name("function") {
                fact.add("callee", Some(callee), source);
                let base = if callee.kind() == "generic_function" {
                    callee.child_by_field_name("function").unwrap_or(callee)
                } else {
                    callee
                };
                let form = match base.kind() {
                    "field_expression" => "method_call",
                    "identifier" => "name_call",
                    "scoped_identifier" => "path_call",
                    _ => "expression_call",
                };
                fact.add(form, Some(base), source);
                if base.kind() == "field_expression" {
                    fact.add("receiver", base.child_by_field_name("value"), source);
                    fact.add("method", base.child_by_field_name("field"), source);
                }
                if callee.kind() == "generic_function" {
                    fact.add(
                        "generics",
                        callee.child_by_field_name("type_arguments"),
                        source,
                    );
                }
            }
            if let Some(arguments) = node.child_by_field_name("arguments") {
                let mut cursor = arguments.walk();
                for argument in arguments
                    .named_children(&mut cursor)
                    .filter(|n| !matches!(n.kind(), "line_comment" | "block_comment"))
                {
                    fact.add("argument", Some(argument), source);
                }
            }
            output.push(fact);
        } else if node.kind() == "macro_invocation" {
            let mut fact = Fact::new("macro_invocation", node, source, entities);
            fact.add("path", node.child_by_field_name("macro"), source);
            let mut cursor = node.walk();
            fact.add(
                "tokens",
                node.named_children(&mut cursor)
                    .find(|n| n.kind() == "token_tree"),
                source,
            );
            output.push(fact);
        }
    }
    let callee_names = merge_ranges(
        output
            .iter()
            .flat_map(|fact| fact.evidence.iter())
            .filter(|e| {
                matches!(
                    e.role.as_str(),
                    "name_call" | "path_call" | "path" | "method"
                )
            })
            .map(|e| (e.span.start, e.span.end))
            .collect(),
    );
    for &node in nodes {
        if is_excluded(node) || node.is_missing() {
            continue;
        }
        let kind = match node.kind() {
            "identifier" | "scoped_identifier" | "self" | "shorthand_field_identifier" => {
                "value_reference"
            }
            "type_identifier" | "scoped_type_identifier" | "primitive_type" => "type_reference",
            "field_identifier" => "field_reference",
            _ => continue,
        };
        if node.parent().is_some_and(|p| {
            matches!(p.kind(), "scoped_identifier" | "scoped_type_identifier")
                || (super::entities::kind(p).is_some()
                    && p.child_by_field_name("name") == Some(node))
        }) {
            continue;
        }
        if covered(node, &callee_names) {
            continue;
        }
        output.push(Fact::new(kind, node, source, entities));
    }
    output
}

fn merge_ranges(mut spans: Vec<(usize, usize)>) -> Vec<(usize, usize)> {
    spans.sort_unstable();
    let mut merged: Vec<(usize, usize)> = Vec::new();
    for (start, end) in spans {
        if let Some(last) = merged.last_mut().filter(|last| last.1 >= start) {
            last.1 = last.1.max(end);
        } else {
            merged.push((start, end));
        }
    }
    merged
}

fn covered(node: Node<'_>, spans: &[(usize, usize)]) -> bool {
    let end = spans.partition_point(|&(start, _)| start <= node.start_byte());
    end > 0 && node.end_byte() <= spans[end - 1].1
}
