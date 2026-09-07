use anyhow::Result;
use tree_sitter::Node;

use crate::source::SourceFile;

pub(crate) mod formats;
mod go;
mod javascript;
pub mod language;
mod native;
mod python;
pub mod relationships;
mod rust;
pub mod source_facts;
mod text;

#[derive(Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
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

impl Fact {
    fn at(kind: &str, span: Span, owner: Option<usize>, scope: usize) -> Self {
        Self {
            kind: kind.into(),
            span,
            owner,
            scope,
            evidence: Vec::new(),
            related: None,
        }
    }
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

impl Diagnostic {
    fn from_node(node: Node<'_>, source: &str) -> Option<Self> {
        (node.is_error() || node.is_missing()).then(|| Self {
            kind: if node.is_missing() {
                format!("missing {}", node.kind())
            } else {
                "ERROR".into()
            },
            span: Span::of(node, source),
            column: node.start_position().column + 1,
        })
    }
}

#[derive(Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Analysis {
    pub source_facts: Vec<source_facts::Fact>,
    pub source_chunks: Vec<crate::retrieval::ts_v2::Chunk>,
    pub source: SourceFile,
    pub diagnostics: Vec<Diagnostic>,
    pub entities: Vec<Entity>,
    pub facts: Vec<Fact>,
    pub scopes: Vec<Scope>,
}

impl Analysis {
    fn new(source: SourceFile, lines: &LineIndex) -> Self {
        Self {
            source_facts: Vec::new(),
            scopes: vec![Scope {
                kind: "file".into(),
                span: lines.span(0, source.text.len()),
                parent: None,
                owner: None,
            }],
            source,
            source_chunks: Vec::new(),
            entities: Vec::new(),
            facts: Vec::new(),
            diagnostics: Vec::new(),
        }
    }
}

pub fn extract(source: SourceFile) -> Result<Analysis> {
    let normalized = crate::retrieval::normalized::Source::new(&source.text);
    let mut analysis = (language::for_path(&source.path).extract)(SourceFile {
        path: source.path.clone(),
        text: normalized.text.clone(),
    })?;
    let lines = LineIndex::new(&source.text);
    let map = |span: &mut Span| -> Result<()> {
        *span = lines.span(
            normalized.raw_offset(span.start)?,
            normalized.raw_offset(span.end)?,
        );
        Ok(())
    };
    for entity in &mut analysis.entities {
        map(&mut entity.span)?;
    }
    for chunk in &mut analysis.source_chunks {
        map(&mut chunk.span)?;
    }
    for fact in &mut analysis.facts {
        map(&mut fact.span)?;
        for evidence in &mut fact.evidence {
            map(&mut evidence.span)?;
        }
    }
    for scope in &mut analysis.scopes {
        map(&mut scope.span)?;
    }
    for fact in &mut analysis.source_facts {
        let remap = |location: &mut source_facts::Location| -> Result<()> {
            let mut span = location.span();
            map(&mut span)?;
            *location = source_facts::Location::from_span(&span);
            Ok(())
        };
        remap(&mut fact.location)?;
        if let Some(owner) = &mut fact.owner {
            remap(&mut owner.location)?;
        }
        if let source_facts::Kind::Call {
            target: Some(target),
            ..
        } = &mut fact.kind
        {
            remap(&mut target.location)?;
        }
    }
    analysis.scopes[0].span = lines.span(0, source.text.len());
    for diagnostic in &mut analysis.diagnostics {
        map(&mut diagnostic.span)?;
        diagnostic.column = lines.column(diagnostic.span.start);
    }
    analysis.source = source;
    Ok(analysis)
}

pub fn report(analysis: &Analysis) -> String {
    let mut output = format!(
        "file: {}\nsource: {} bytes\nparse: {}\n",
        analysis.source.path,
        analysis.source.text.len(),
        if !language::for_path(&analysis.source.path).is_native {
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
    for fact in &analysis.source_facts {
        output.push_str(&format!("source fact: {}\n", serde_json::json!(fact)));
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
