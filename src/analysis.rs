use anyhow::{Context, Result};
use tree_sitter::{Node, Parser};

use crate::source::SourceFile;

mod entities;
pub use entities::Entity;

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
