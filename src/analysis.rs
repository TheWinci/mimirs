use anyhow::Result;
use tree_sitter::Node;

use crate::source::SourceFile;

pub mod language;
mod rust;
mod text;

#[derive(Debug, PartialEq, Eq)]
pub struct Entity {
    pub kind: String,
    pub name: Option<String>,
    pub span: Span,
    pub parent: Option<usize>,
}

#[derive(Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Evidence {
    pub role: String,
    pub span: Span,
}

#[derive(Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Fact {
    pub kind: String,
    pub span: Span,
    pub owner: Option<usize>,
    pub evidence: Vec<Evidence>,
    pub related: Option<usize>,
    pub scope: usize,
}

#[derive(Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Scope {
    pub kind: String,
    pub span: Span,
    pub parent: Option<usize>,
    pub owner: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Span {
    pub start: usize,
    pub end: usize,
    pub line_start: usize,
    pub line_end: usize,
}

impl Span {
    fn of(node: Node<'_>, source: &str) -> Self {
        let start = node.start_byte();
        let end = node.end_byte();
        Self {
            start,
            end,
            line_start: node.start_position().row + 1,
            line_end: node.end_position().row
                + usize::from(end == start || source.as_bytes()[end - 1] != b'\n'),
        }
    }
}

/// One newline index serves computed spans and storage validation.
pub(crate) struct LineIndex {
    starts: Vec<usize>,
}

impl LineIndex {
    pub fn new(source: &str) -> Self {
        let mut starts = vec![0];
        starts.extend(
            source
                .bytes()
                .enumerate()
                .filter_map(|(i, byte)| (byte == b'\n').then_some(i + 1)),
        );
        Self { starts }
    }

    pub fn column(&self, offset: usize) -> usize {
        let line = self.starts.partition_point(|&s| s <= offset) - 1;
        offset - self.starts[line] + 1
    }

    pub fn span(&self, start: usize, end: usize) -> Span {
        let line = |offset| self.starts.partition_point(|&s| s <= offset);
        Span {
            start,
            end,
            line_start: line(start),
            line_end: line(if end > start { end - 1 } else { end }),
        }
    }
}

#[derive(Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
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
    pub scopes: Vec<Scope>,
}

pub fn extract(source: SourceFile) -> Result<Analysis> {
    (language::for_path(&source.path).extract)(source)
}

pub fn report(analysis: &Analysis) -> String {
    let mut output = format!(
        "file: {}\nsource: {} bytes\nparse: {}\n",
        analysis.source.path,
        analysis.source.text.len(),
        if matches!(
            language::for_path(&analysis.source.path).chunking,
            language::Chunking::Paragraphs
        ) {
            "not parsed (text fallback)"
        } else if analysis.diagnostics.is_empty() {
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
    for (id, scope) in analysis.scopes.iter().enumerate() {
        output.push_str(&format!(
            "scope s{id}: {} bytes {}..{} parent {} owner {}\n",
            scope.kind,
            scope.span.start,
            scope.span.end,
            scope
                .parent
                .map_or_else(|| "none".into(), |id| format!("s{id}")),
            scope
                .owner
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
        output.push_str(&format!("  scope s{}\n", fact.scope));
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
