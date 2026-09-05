use anyhow::{Context, Result};
use tree_sitter::{Node, Parser};

use crate::source::SourceFile;

mod entities;
mod facts;
mod imports;
mod signatures;
pub use entities::Entity;
pub use facts::Fact;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Span {
    pub start: usize,
    pub end: usize,
    pub line_start: usize,
    pub line_end: usize,
}

impl Span {
    pub fn at(source: &str, start: usize, end: usize) -> Self {
        let line = |offset| {
            source.as_bytes()[..offset]
                .iter()
                .filter(|&&b| b == b'\n')
                .count()
                + 1
        };
        Self {
            start,
            end,
            line_start: line(start),
            line_end: line(if end > start { end - 1 } else { end }),
        }
    }

    fn of(node: Node<'_>, source: &str) -> Self {
        Self::at(source, node.start_byte(), node.end_byte())
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct Diagnostic {
    pub kind: String,
    pub span: Span,
    pub column: usize,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Analysis {
    pub source: SourceFile,
    pub diagnostics: Vec<Diagnostic>,
    pub entities: Vec<Entity>,
    pub facts: Vec<Fact>,
}

pub fn extract(source: SourceFile) -> Result<Analysis> {
    let mut parser = Parser::new();
    parser
        .set_language(&tree_sitter_rust::LANGUAGE.into())
        .context("cannot initialize Rust parser")?;
    let tree = parser
        .parse(&source.text, None)
        .context("Rust parser returned no tree")?;
    let entities = entities::extract(tree.root_node(), &source.text);
    let mut facts = facts::extract(tree.root_node(), &source.text, &entities);
    facts.extend(signatures::extract(
        tree.root_node(),
        &source.text,
        &entities,
    ));
    facts.extend(imports::extract(tree.root_node(), &source.text, &entities));
    facts.sort_by_key(|fact| (fact.span.start, fact.span.end));
    for id in 0..facts.len() {
        if facts[id].kind == "import_member" {
            facts[id].related = facts[id]
                .evidence
                .iter()
                .find(|e| e.role == "declaration")
                .and_then(|e| {
                    facts
                        .iter()
                        .position(|f| f.kind == "import" && f.span == e.span)
                });
        }
    }
    let mut diagnostics = Vec::new();
    let mut cursor = tree.walk();
    loop {
        let node = cursor.node();
        if node.is_error() || node.is_missing() {
            diagnostics.push(Diagnostic {
                kind: if node.is_missing() {
                    format!("missing {}", node.kind())
                } else {
                    "ERROR".into()
                },
                span: Span::of(node, &source.text),
                column: node.start_position().column + 1,
            });
        }
        if cursor.goto_first_child() {
            continue;
        }
        loop {
            if cursor.goto_next_sibling() {
                break;
            }
            if !cursor.goto_parent() {
                return Ok(Analysis {
                    source,
                    diagnostics,
                    entities,
                    facts,
                });
            }
        }
    }
}

pub fn report(analysis: &Analysis) -> String {
    let mut output = format!(
        "file: {}\nsource: {} bytes\nparse: {}\n",
        analysis.source.path,
        analysis.source.text.len(),
        if analysis.diagnostics.is_empty() {
            "complete"
        } else {
            "incomplete"
        }
    );
    for (id, entity) in analysis.entities.iter().enumerate() {
        let mut ancestor = entity.parent;
        while let Some(parent) = ancestor {
            output.push_str("  ");
            ancestor = analysis.entities[parent].parent;
        }
        output.push_str(&format!(
            "entity e{id}: {} {:?} bytes {}..{} lines {}..{} parent {}\n",
            entity.kind,
            entity.name,
            entity.span.start,
            entity.span.end,
            entity.span.line_start,
            entity.span.line_end,
            entity
                .parent
                .map_or_else(|| "file".into(), |id| format!("e{id}"))
        ));
    }
    for (id, fact) in analysis.facts.iter().enumerate() {
        output.push_str(&format!(
            "fact f{id}: {} bytes {}..{} lines {}..{} owner {} text {:?}\n",
            fact.kind,
            fact.span.start,
            fact.span.end,
            fact.span.line_start,
            fact.span.line_end,
            fact.owner
                .map_or_else(|| "file".into(), |id| format!("e{id}")),
            &analysis.source.text[fact.span.start..fact.span.end]
        ));
        if let Some(related) = fact.related {
            output.push_str(&format!("  related f{related}\n"));
        }
        for evidence in &fact.evidence {
            output.push_str(&format!(
                "  {} bytes {}..{} text {:?}\n",
                evidence.role,
                evidence.span.start,
                evidence.span.end,
                &analysis.source.text[evidence.span.start..evidence.span.end]
            ));
        }
    }
    for diagnostic in &analysis.diagnostics {
        output.push_str(&format!(
            "diagnostic: {} bytes {}..{} lines {}..{} column {}\n",
            diagnostic.kind,
            diagnostic.span.start,
            diagnostic.span.end,
            diagnostic.span.line_start,
            diagnostic.span.line_end,
            diagnostic.column
        ));
    }
    output
}

#[cfg(test)]
#[path = "../tests/unit/analysis.rs"]
mod tests;
