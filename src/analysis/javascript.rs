//! Written declarations shared by the JavaScript, TypeScript and TSX grammars.
use anyhow::{Context, Result};
use tree_sitter::{Node, Parser};

use super::language::Language;
#[cfg(test)]
use super::language::{Chunking, DeclarationRules};
use super::{Analysis, Diagnostic, Entity, Fact, LineIndex, Scope, Span};
use crate::source::SourceFile;

#[cfg(test)]
const RULES: Chunking = Chunking::Declarations(DeclarationRules {
    containers: &["class", "namespace"],
    leading_facts: &["doc", "decorator", "wrapper"],
    signature_fact: "signature",
});

pub(super) const JAVASCRIPT: Language = Language {
    identity: "javascript/jsx/tree-sitter-0.27.0/javascript-0.25.0/extractor-1/source-facts-1",
    extensions: &["js", "mjs", "cjs", "jsx"],
    extract: |source| extract(source, tree_sitter_javascript::LANGUAGE.into()),
    is_native: true,
    #[cfg(test)]
    chunking: RULES,
};
pub(super) const TYPESCRIPT: Language = Language {
    identity: "typescript/default/tree-sitter-0.27.0/typescript-0.23.2/extractor-1/source-facts-1",
    extensions: &["ts", "mts", "cts"],
    extract: |source| extract(source, tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()),
    is_native: true,
    #[cfg(test)]
    chunking: RULES,
};
pub(super) const TSX: Language = Language {
    identity: "typescript/tsx/tree-sitter-0.27.0/typescript-0.23.2/extractor-1/source-facts-1",
    extensions: &["tsx"],
    extract: |source| extract(source, tree_sitter_typescript::LANGUAGE_TSX.into()),
    is_native: true,
    #[cfg(test)]
    chunking: RULES,
};

fn extract(source: SourceFile, language: tree_sitter::Language) -> Result<Analysis> {
    let mut parser = Parser::new();
    parser
        .set_language(&language)
        .context("cannot initialize JavaScript/TypeScript parser")?;
    let tree = parser
        .parse(&source.text, None)
        .context("JavaScript/TypeScript parser returned no tree")?;
    let lines = LineIndex::new(&source.text);
    let mut analysis = Analysis::new(source, &lines);
    let mut stack = vec![(tree.root_node(), None::<usize>, 0, false)];
    while let Some((node, mut owner, mut scope, mut opaque)) = stack.pop() {
        analysis
            .diagnostics
            .extend(Diagnostic::from_node(node, &analysis.source.text));
        if !opaque
            && node.is_named()
            && !node.is_missing()
            && node.start_byte() < node.end_byte()
            && let Some((kind, name)) = declaration(node, owner, &analysis)
        {
            let id = analysis.entities.len();
            let span = Span::of(node, &analysis.source.text);
            analysis.entities.push(Entity {
                kind: kind.into(),
                name,
                span: span.clone(),
                parent: owner,
            });
            attach(node, id, scope, &lines, &mut analysis);
            owner = Some(id);
            if matches!(kind, "class" | "namespace" | "function" | "method") {
                let parent = scope;
                scope = analysis.scopes.len();
                analysis.scopes.push(Scope {
                    kind: "item".into(),
                    span,
                    parent: Some(parent),
                    owner,
                });
            }
            if let Some(span) = signature(node, kind, &analysis.source.text, &lines) {
                analysis
                    .facts
                    .push(Fact::at("signature", span, Some(id), scope));
            }
            opaque = matches!(
                kind,
                "variable" | "field" | "interface" | "type_alias" | "enum" | "export"
            );
        } else if matches!(
            node.kind(),
            "class" | "function_expression" | "generator_function" | "arrow_function"
        ) {
            // An unowned expression stays in its surrounding source. Do not
            // promote declarations in an IIFE or object initializer to globals.
            opaque = true;
        }
        opaque |= matches!(
            node.kind(),
            "decorator" | "computed_property_name" | "class_static_block" | "object"
        );
        let mut cursor = node.walk();
        let children: Vec<_> = node.children(&mut cursor).collect();
        stack.extend(
            children
                .into_iter()
                .rev()
                .map(|child| (child, owner, scope, opaque)),
        );
    }
    analysis.facts.sort_by_key(|f| (f.span.start, f.span.end));
    analysis.source_chunks = crate::retrieval::ts_v2::from_tree(
        &analysis.source.text,
        tree.root_node(),
        &language,
        match std::path::Path::new(&analysis.source.path)
            .extension()
            .and_then(|s| s.to_str())
        {
            Some("tsx") => "tsx",
            Some("ts" | "mts" | "cts") => "typescript",
            _ => "javascript",
        },
        &analysis.entities,
    )?;
    analysis.source_facts = super::source_facts::extract(
        if analysis
            .source
            .path
            .rsplit('.')
            .next()
            .is_some_and(|extension| matches!(extension, "ts" | "mts" | "cts" | "tsx"))
        {
            "typescript"
        } else {
            "javascript"
        },
        &analysis.source.text,
        tree.root_node(),
        &analysis.source_chunks,
    );
    Ok(analysis)
}

fn declaration(
    node: Node<'_>,
    owner: Option<usize>,
    analysis: &Analysis,
) -> Option<(&'static str, Option<String>)> {
    let class_member = node.parent().is_some_and(|p| p.kind() == "class_body")
        && owner.is_some_and(|id| analysis.entities[id].kind == "class");
    let kind = match node.kind() {
        "function_declaration" | "generator_function_declaration" | "function_signature" => {
            "function"
        }
        "class_declaration" | "abstract_class_declaration" => "class",
        "class" if default_value(node) => "class",
        "function_expression" | "generator_function" if default_value(node) => "function",
        "method_definition" | "method_signature" | "abstract_method_signature" if class_member => {
            "method"
        }
        "public_field_definition" | "field_definition" if class_member => "field",
        "interface_declaration" => "interface",
        "type_alias_declaration" => "type_alias",
        "enum_declaration" => "enum",
        "internal_module" | "module" => "namespace",
        "lexical_declaration" | "variable_declaration" if module_boundary(node) => "variable",
        "export_statement"
            if node.child_by_field_name("value").is_some_and(|v| {
                !matches!(
                    v.kind(),
                    "class" | "function_expression" | "generator_function"
                )
            }) =>
        {
            "export"
        }
        _ => return None,
    };
    let name = if kind == "variable" {
        let mut cursor = node.walk();
        let bindings: Vec<_> = node
            .named_children(&mut cursor)
            .filter(|n| n.kind() == "variable_declarator")
            .collect();
        (bindings.len() == 1)
            .then(|| bindings[0].child_by_field_name("name"))
            .flatten()
            .filter(|n| n.kind() == "identifier")
    } else {
        node.child_by_field_name("name")
            .or_else(|| node.child_by_field_name("property"))
    }
    .filter(|n| !n.is_missing() && n.start_byte() < n.end_byte());
    if name.is_none() && !matches!(kind, "variable" | "export") && !default_value(node) {
        return None;
    }
    Some((
        kind,
        name.map(|n| analysis.source.text[n.byte_range()].to_owned()),
    ))
}

fn default_value(node: Node<'_>) -> bool {
    node.parent().is_some_and(|p| {
        p.kind() == "export_statement" && p.child_by_field_name("value") == Some(node)
    })
}

fn wrapper(mut node: Node<'_>) -> Node<'_> {
    while let Some(parent) = node.parent() {
        if parent.kind() == "ambient_declaration"
            || (parent.kind() == "export_statement"
                && (parent.child_by_field_name("declaration") == Some(node)
                    || parent.child_by_field_name("value") == Some(node)))
        {
            node = parent;
        } else {
            break;
        }
    }
    node
}

fn module_boundary(node: Node<'_>) -> bool {
    wrapper(node).parent().is_some_and(|parent| {
        parent.kind() == "program"
            || (parent.kind() == "statement_block"
                && parent.parent().is_some_and(|p| {
                    matches!(
                        p.kind(),
                        "internal_module" | "module" | "ambient_declaration"
                    )
                }))
    })
}

fn attach(node: Node<'_>, owner: usize, scope: usize, lines: &LineIndex, analysis: &mut Analysis) {
    let outer = wrapper(node);
    if outer.start_byte() < node.start_byte() {
        analysis.facts.push(Fact::at(
            "wrapper",
            lines.span(outer.start_byte(), node.start_byte()),
            Some(owner),
            scope,
        ));
    }
    // Some grammars put decorators in the declaration; TS methods have sibling
    // decorators. Both representations attach to the same source owner.
    for parent in std::iter::once(node).chain((outer != node).then_some(outer)) {
        let mut cursor = parent.walk();
        for decorator in parent
            .named_children(&mut cursor)
            .filter(|n| n.kind() == "decorator")
        {
            analysis.facts.push(Fact::at(
                "decorator",
                Span::of(decorator, &analysis.source.text),
                Some(owner),
                scope,
            ));
        }
    }
    let mut first = outer;
    while let Some(previous) = first
        .prev_named_sibling()
        .filter(|p| p.kind() == "decorator")
    {
        if !analysis.source.text[previous.end_byte()..first.start_byte()]
            .trim()
            .is_empty()
        {
            break;
        }
        analysis.facts.push(Fact::at(
            "decorator",
            Span::of(previous, &analysis.source.text),
            Some(owner),
            scope,
        ));
        first = previous;
    }
    if let Some(doc) = first.prev_named_sibling().filter(|n| n.kind() == "comment") {
        let gap = &analysis.source.text[doc.end_byte()..first.start_byte()];
        let text = &analysis.source.text[doc.byte_range()];
        if text.starts_with("/**")
            && text.ends_with("*/")
            && gap.trim().is_empty()
            && gap.bytes().filter(|b| *b == b'\n').count() <= 1
        {
            analysis.facts.push(Fact::at(
                "doc",
                Span::of(doc, &analysis.source.text),
                Some(owner),
                scope,
            ));
        }
    }
}

fn signature(node: Node<'_>, kind: &str, source: &str, lines: &LineIndex) -> Option<Span> {
    let mut cursor = node.walk();
    let start = node
        .children(&mut cursor)
        .find(|n| !matches!(n.kind(), "decorator" | "comment"))?
        .start_byte();
    let mut single_binding = true;
    let value = if kind == "variable" {
        let mut cursor = node.walk();
        single_binding = node
            .named_children(&mut cursor)
            .filter(|n| n.kind() == "variable_declarator")
            .count()
            == 1;
        node.named_children(&mut cursor)
            .filter(|n| n.kind() == "variable_declarator")
            .find_map(|n| n.child_by_field_name("value"))
    } else {
        node.child_by_field_name("value")
    };
    let end = if let Some(body) = node.child_by_field_name("body") {
        body.start_byte()
    } else if let Some(value) = value {
        if single_binding
            && matches!(kind, "variable" | "field")
            && matches!(
                value.kind(),
                "arrow_function" | "function_expression" | "generator_function"
            )
        {
            value
                .child_by_field_name("body")
                .map_or(value.start_byte(), |b| b.start_byte())
        } else {
            value.start_byte()
        }
    } else {
        node.end_byte()
    };
    (end > start).then(|| lines.span(start, start + source[start..end].trim_end().len()))
}

#[cfg(test)]
#[path = "../../tests/unit/javascript.rs"]
mod tests;
