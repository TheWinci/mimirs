//! Go source declarations, without package loading or binding resolution.
use anyhow::{Context, Result};
use tree_sitter::{Node, Parser};

use super::language::Language;
#[cfg(test)]
use super::language::{Chunking, DeclarationRules};
use super::{Analysis, Diagnostic, Entity, Fact, LineIndex, Scope, Span};
use crate::source::SourceFile;

const GROUPS: &[&str] = &["const_group", "variable_group", "type_group"];
pub(super) const LANGUAGE: Language = Language {
    identity: "go/default/tree-sitter-0.27.0/go-0.25.0/extractor-1/source-facts-1",
    extensions: &["go"],
    extract,
    is_native: true,
    #[cfg(test)]
    chunking: Chunking::Declarations(DeclarationRules {
        containers: GROUPS,
        leading_facts: &["doc"],
        signature_fact: "signature",
    }),
};

fn extract(source: SourceFile) -> Result<Analysis> {
    let mut parser = Parser::new();
    parser
        .set_language(&tree_sitter_go::LANGUAGE.into())
        .context("cannot initialize Go parser")?;
    let tree = parser
        .parse(&source.text, None)
        .context("Go parser returned no tree")?;
    let lines = LineIndex::new(&source.text);
    let mut analysis = Analysis::new(source, &lines);
    let mut stack = vec![(tree.root_node(), None::<usize>)];
    while let Some((node, mut owner)) = stack.pop() {
        analysis
            .diagnostics
            .extend(Diagnostic::from_node(node, &analysis.source.text));
        if !node.is_missing()
            && node.start_byte() < node.end_byte()
            && let Some((kind, spec)) = declaration(node, owner, &analysis)
        {
            let group = GROUPS.contains(&kind);
            let name = written_name(spec, &analysis.source.text);
            // A recovered var/const spec can remain unnamed. A callable or type
            // needs a written name; never use a missing token as its identity.
            let mut cursor = spec.walk();
            let has_name = spec
                .children_by_field_name("name", &mut cursor)
                .any(|n| n.is_named() && !n.is_missing() && n.start_byte() < n.end_byte());
            if group || has_name {
                let id = analysis.entities.len();
                let span = Span::of(node, &analysis.source.text);
                analysis.entities.push(Entity {
                    kind: kind.into(),
                    name: if group { None } else { name },
                    span: span.clone(),
                    parent: owner,
                });
                attach_docs(node, id, &lines, &mut analysis);
                let scope = if matches!(kind, "function" | "method") {
                    let scope = analysis.scopes.len();
                    analysis.scopes.push(Scope {
                        kind: "item".into(),
                        span,
                        parent: Some(0),
                        owner: Some(id),
                    });
                    scope
                } else {
                    0
                };
                if !group {
                    let end = if matches!(kind, "function" | "method") {
                        spec.child_by_field_name("body")
                            .map_or(spec.end_byte(), |n| n.start_byte())
                    } else {
                        ["type", "value"]
                            .into_iter()
                            .filter_map(|field| spec.child_by_field_name(field))
                            .map(|n| n.start_byte())
                            .min()
                            .unwrap_or(spec.end_byte())
                    };
                    let start = node.start_byte();
                    let end = start + analysis.source.text[start..end].trim_end().len();
                    if end > start {
                        analysis.facts.push(Fact::at(
                            "signature",
                            lines.span(start, end),
                            Some(id),
                            scope,
                        ));
                    }
                }
                owner = Some(id);
            }
        }
        // Even inside leaves, traverse recovery nodes to collect diagnostics.
        let mut cursor = node.walk();
        let children: Vec<_> = node.children(&mut cursor).collect();
        stack.extend(children.into_iter().rev().map(|child| (child, owner)));
    }
    analysis.facts.sort_by_key(|f| (f.span.start, f.span.end));
    analysis.source_chunks = crate::analysis::chunks::from_tree(
        &analysis.source.text,
        tree.root_node(),
        &tree_sitter_go::LANGUAGE.into(),
        "go",
        &analysis.entities,
    )?;
    analysis.source_facts = super::source_facts::extract(
        "go",
        &analysis.source.text,
        tree.root_node(),
        &analysis.source_chunks,
    );
    Ok(analysis)
}

fn declaration<'a>(
    node: Node<'a>,
    owner: Option<usize>,
    analysis: &Analysis,
) -> Option<(&'static str, Node<'a>)> {
    if node.parent().is_some_and(|p| p.kind() == "source_file") {
        let group_kind = match node.kind() {
            "function_declaration" => return Some(("function", node)),
            "method_declaration" => return Some(("method", node)),
            "const_declaration" => "const_group",
            "var_declaration" => "variable_group",
            "type_declaration" => "type_group",
            _ => return None,
        };
        let mut cursor = node.walk();
        if node
            .children(&mut cursor)
            .any(|n| n.kind() == "(" || n.kind() == "var_spec_list")
        {
            return Some((group_kind, node));
        }
        let spec = node
            .named_children(&mut cursor)
            .find(|n| spec_kind(*n).is_some())?;
        return Some((spec_kind(spec)?, spec));
    }
    let kind = spec_kind(node)?;
    let group = &analysis.entities[owner?];
    if !GROUPS.contains(&group.kind.as_str()) {
        return None;
    }
    let mut parent = node.parent()?;
    if parent.kind() == "var_spec_list" {
        parent = parent.parent()?;
    }
    // Only direct specs of the owning declaration group qualify. Types or
    // bindings in its initializers stay in the spec's source.
    (parent.start_byte() == group.span.start && parent.end_byte() == group.span.end)
        .then_some((kind, node))
}

fn spec_kind(node: Node<'_>) -> Option<&'static str> {
    match node.kind() {
        "const_spec" => Some("const"),
        "var_spec" => Some("variable"),
        "type_spec" => Some("type"),
        "type_alias" => Some("type_alias"),
        _ => None,
    }
}

fn written_name(node: Node<'_>, source: &str) -> Option<String> {
    let mut cursor = node.walk();
    // const_spec assigns the name field to commas too; var_spec does not.
    let mut names = node
        .children_by_field_name("name", &mut cursor)
        .filter(|n| n.is_named());
    let name = names.next()?;
    (names.next().is_none()
        && !name.is_missing()
        && name.start_byte() < name.end_byte()
        && &source[name.byte_range()] != "_")
        .then(|| source[name.byte_range()].into())
}

fn attach_docs(node: Node<'_>, owner: usize, lines: &LineIndex, analysis: &mut Analysis) {
    let mut first = node;
    while let Some(doc) = first.prev_named_sibling().filter(|n| n.kind() == "comment") {
        let gap = &analysis.source.text[doc.end_byte()..first.start_byte()];
        let line_start = analysis.source.text[..doc.start_byte()]
            .rfind('\n')
            .map_or(0, |i| i + 1);
        if !gap.trim().is_empty()
            || gap.bytes().filter(|b| *b == b'\n').count() > 1
            || !analysis.source.text[line_start..doc.start_byte()]
                .trim()
                .is_empty()
        {
            break;
        }
        analysis.facts.push(Fact::at(
            "doc",
            lines.span(doc.start_byte(), doc.end_byte()),
            Some(owner),
            0,
        ));
        first = doc;
    }
}

#[cfg(test)]
#[path = "../../tests/unit/go.rs"]
mod tests;
