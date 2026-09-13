//! Retrieval windows and presentation over analyzed source chunks.
pub use crate::analysis::chunks::Chunk;
#[cfg(test)]
pub use crate::analysis::chunks::{from_tree, text_chunks};
use crate::analysis::{LineIndex, Span};
use anyhow::Result;
mod windows;
pub use windows::project;

pub const POLICY: &str = "ts-v2-source-windows-4000-path-average-256-32-2";

pub fn documents(analysis: &crate::analysis::Analysis) -> Result<Vec<super::split::Document>> {
    crate::analysis::validation::validate(analysis)?;
    let normalized = crate::source::normalized::Source::new(&analysis.source.text);
    let lines = LineIndex::new(&analysis.source.text);
    let mut parts = std::collections::HashMap::new();
    project(&analysis.source.text, &analysis.source_chunks, 4000)?
        .into_iter()
        .map(|window| {
            let part = parts.entry(window.chunk).or_insert(0);
            let document = super::split::Document {
                source_chunk: Some(window.chunk),
                owner: analysis.source_chunks[window.chunk].owner,
                part: *part,
                text: format!(
                    "File: {}\n{}",
                    analysis.source.path,
                    &normalized.text[normalized.normalized_offset(window.start)?
                        ..normalized.normalized_offset(window.end)?]
                ),
                evidence: vec![super::Evidence {
                    record: super::Record::Source,
                    span: lines.span(window.start, window.end),
                }],
            };
            *part += 1;
            Ok(document)
        })
        .collect()
}

#[derive(serde::Serialize)]
pub struct Preview {
    pub source_chunk: usize,
    pub owner: Option<usize>,
    pub kind: String,
    pub name: Option<String>,
    pub context: String,
    pub text: String,
    pub span: Span,
}

pub fn preview(analysis: &crate::analysis::Analysis) -> Result<Vec<Preview>> {
    crate::analysis::validation::validate(analysis)?;
    let lines = LineIndex::new(&analysis.source.text);
    project(&analysis.source.text, &analysis.source_chunks, 4000)?
        .into_iter()
        .map(|w| {
            let chunk = &analysis.source_chunks[w.chunk];
            Ok(Preview {
                source_chunk: w.chunk,
                owner: chunk.owner,
                kind: chunk.kind.clone(),
                name: chunk.name.clone(),
                context: format!("File: {}", analysis.source.path),
                text: analysis.source.text[w.start..w.end].to_owned(),
                span: lines.span(w.start, w.end),
            })
        })
        .collect()
}

#[cfg(test)]
#[path = "../../tests/unit/ts_v2_source.rs"]
mod tests;
