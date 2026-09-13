use anyhow::{Context, Result};
use tree_sitter::{Node, Parser};

use super::language::Language;
#[cfg(test)]
use super::language::{Chunking, DeclarationRules};
use super::{Analysis, Diagnostic, Entity, Fact, LineIndex, Scope, Span};
use crate::source::SourceFile;

pub(super) const LANGUAGE: Language = Language {
    identity: "python/default/tree-sitter-0.27.0/python-0.25.0/extractor-1/source-facts-1",
    extensions: &["py", "pyi"],
    extract,
    is_native: true,
    #[cfg(test)]
    chunking: Chunking::Declarations(DeclarationRules {
        containers: &["class"],
        leading_facts: &["decorator"],
        signature_fact: "signature",
    }),
};

fn extract(source: SourceFile) -> Result<Analysis> {
    let mut parser = Parser::new();
    parser
        .set_language(&tree_sitter_python::LANGUAGE.into())
        .context("cannot initialize Python parser")?;
    let tree = parser
        .parse(&source.text, None)
        .context("Python parser returned no tree")?;
    let lines = LineIndex::new(&source.text);
    let mut analysis = Analysis::new(source, &lines);
    if let Some(doc) = docstring(tree.root_node(), &analysis.source.text) {
        analysis.facts.push(Fact::at(
            "doc",
            Span::of(doc, &analysis.source.text),
            None,
            0,
        ));
    }
    let mut stack = vec![(tree.root_node(), None::<usize>, 0)];
    while let Some((node, mut owner, mut scope)) = stack.pop() {
        analysis
            .diagnostics
            .extend(Diagnostic::from_node(node, &analysis.source.text));
        if matches!(node.kind(), "class_definition" | "function_definition")
            && let Some(name) = node
                .child_by_field_name("name")
                .filter(|name| !name.is_missing())
        {
            let kind = if node.kind() == "class_definition" {
                "class"
            } else if owner.is_some_and(|id| analysis.entities[id].kind == "class") {
                "method"
            } else {
                "function"
            };
            let id = analysis.entities.len();
            let span = Span::of(node, &analysis.source.text);
            analysis.entities.push(Entity {
                kind: kind.into(),
                name: Some(analysis.source.text[name.byte_range()].into()),
                span: span.clone(),
                parent: owner,
            });
            // Decorators precede the raw definition span, so they belong to the
            // enclosing scope while referring to the decorated entity as owner.
            if let Some(wrapper) = node.parent().filter(|p| p.kind() == "decorated_definition") {
                let mut cursor = wrapper.walk();
                for decorator in wrapper
                    .named_children(&mut cursor)
                    .filter(|n| n.kind() == "decorator")
                {
                    analysis.facts.push(Fact::at(
                        "decorator",
                        Span::of(decorator, &analysis.source.text),
                        Some(id),
                        scope,
                    ));
                }
            }
            let parent_scope = scope;
            scope = analysis.scopes.len();
            owner = Some(id);
            analysis.scopes.push(Scope {
                kind: "item".into(),
                span,
                parent: Some(parent_scope),
                owner,
            });
            // Match only the definition's own colon, not colons inside defaults
            // or annotations. Do not fabricate a signature for a missing token.
            let mut cursor = node.walk();
            if let Some(colon) = node
                .children(&mut cursor)
                .find(|n| n.kind() == ":" && !n.is_missing())
            {
                analysis.facts.push(Fact::at(
                    "signature",
                    lines.span(node.start_byte(), colon.end_byte()),
                    owner,
                    scope,
                ));
            }
            if let Some(body) = node.child_by_field_name("body")
                && let Some(doc) = docstring(body, &analysis.source.text)
            {
                analysis.facts.push(Fact::at(
                    "doc",
                    Span::of(doc, &analysis.source.text),
                    owner,
                    scope,
                ));
            }
        }
        let mut cursor = node.walk();
        let children: Vec<_> = node.children(&mut cursor).collect();
        stack.extend(
            children
                .into_iter()
                .rev()
                .map(|child| (child, owner, scope)),
        );
    }
    analysis
        .facts
        .sort_by_key(|fact| (fact.span.start, fact.span.end));
    analysis.source_chunks = crate::analysis::chunks::from_tree(
        &analysis.source.text,
        tree.root_node(),
        &tree_sitter_python::LANGUAGE.into(),
        "python",
        &analysis.entities,
    )?;
    analysis.source_facts = super::source_facts::extract(
        "python",
        &analysis.source.text,
        tree.root_node(),
        &analysis.source_chunks,
    );
    if analysis.source.path.ends_with(".pyi") {
        analysis
            .source_facts
            .retain(|fact| matches!(fact.kind, super::source_facts::Kind::Import { .. }));
    }
    Ok(analysis)
}

fn docstring<'a>(body: Node<'a>, source: &str) -> Option<Node<'a>> {
    let mut cursor = body.walk();
    let statement = body
        .named_children(&mut cursor)
        .find(|n| n.kind() != "comment")?;
    if statement.kind() != "expression_statement" || statement.named_child_count() != 1 {
        return None;
    }
    let expression = statement.named_child(0)?;
    plain_string(expression, source).then_some(expression)
}

fn plain_string(node: Node<'_>, source: &str) -> bool {
    match node.kind() {
        "string" => {
            let Some(start) = node.child(0).filter(|n| n.kind() == "string_start") else {
                return false;
            };
            let prefix = source[start.byte_range()].to_ascii_lowercase();
            !prefix.contains(['b', 'f'])
        }
        "concatenated_string" => {
            let mut cursor = node.walk();
            node.named_children(&mut cursor)
                .all(|child| plain_string(child, source))
        }
        "parenthesized_expression" if node.named_child_count() == 1 => {
            plain_string(node.named_child(0).unwrap(), source)
        }
        _ => false,
    }
}

#[cfg(test)]
#[path = "../../tests/unit/python.rs"]
mod tests;
