use super::{Entity, Fact, Span};
use crate::analysis::Evidence;
use tree_sitter::Node;

impl Fact {
    pub(super) fn new(kind: &str, node: Node<'_>, source: &str, entities: &[Entity]) -> Self {
        Self {
            kind: kind.into(),
            span: Span::of(node, source),
            owner: owner(node, entities),
            evidence: Vec::new(),
            related: None,
            scope: 0,
        }
    }

    pub(super) fn add(&mut self, role: &str, node: Option<Node<'_>>, source: &str) {
        if let Some(node) = node.filter(|n| !n.is_missing()) {
            self.evidence.push(Evidence {
                role: role.into(),
                span: Span::of(node, source),
            });
        }
    }
}

pub(super) fn owner(node: Node<'_>, entities: &[Entity]) -> Option<usize> {
    let end = entities.partition_point(|e| e.span.start <= node.start_byte());
    entities[..end]
        .iter()
        .rposition(|e| e.span.start <= node.start_byte() && e.span.end >= node.end_byte())
}

pub(super) fn nodes(root: Node<'_>) -> Vec<Node<'_>> {
    let mut output = Vec::new();
    let mut stack = vec![root];
    while let Some(node) = stack.pop() {
        output.push(node);
        if matches!(
            node.kind(),
            "macro_definition" | "token_tree" | "line_comment" | "block_comment"
        ) {
            continue;
        }
        let mut cursor = node.walk();
        let children: Vec<_> = node.named_children(&mut cursor).collect();
        stack.extend(children.into_iter().rev());
    }
    output
}

pub(super) fn extract(root: Node<'_>, source: &str, entities: &[Entity]) -> Vec<Fact> {
    let mut facts = Vec::new();
    for node in nodes(root) {
        let attribute = matches!(node.kind(), "attribute_item" | "inner_attribute_item");
        let comment = matches!(node.kind(), "line_comment" | "block_comment");
        if !attribute && !comment {
            continue;
        }
        let outer = node.kind() == "attribute_item" || node.child_by_field_name("outer").is_some();
        let doc = comment && node.child_by_field_name("doc").is_some();
        let kind = if attribute {
            "attribute"
        } else if doc {
            "doc"
        } else {
            "comment"
        };
        let mut fact = Fact::new(kind, node, source, entities);
        if outer {
            let mut next = node.next_named_sibling();
            while let Some(sibling) = next {
                if let Some(id) = exact_entity(sibling, entities) {
                    fact.owner = Some(id);
                    break;
                }
                if !matches!(
                    sibling.kind(),
                    "line_comment" | "block_comment" | "attribute_item" | "visibility_modifier"
                ) {
                    break;
                }
                next = sibling.next_named_sibling();
            }
        }
        if attribute && let Some(attr) = node.named_child(0) {
            fact.add("path", attr.named_child(0), source);
            let mut cursor = attr.walk();
            for child in attr.named_children(&mut cursor).skip(1) {
                fact.add("arguments", Some(child), source);
            }
        }
        facts.push(fact);
    }
    facts
}

pub(super) fn exact_entity(node: Node<'_>, entities: &[Entity]) -> Option<usize> {
    let start = entities.partition_point(|e| e.span.start < node.start_byte());
    entities[start..]
        .iter()
        .take_while(|e| e.span.start == node.start_byte())
        .position(|e| e.span.end == node.end_byte())
        .map(|id| start + id)
}
