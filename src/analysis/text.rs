use anyhow::Result;

#[cfg(test)]
use super::language::Chunking;
use super::language::Language;
use super::{Analysis, LineIndex, Scope};
use crate::source::SourceFile;

pub(super) const LANGUAGE: Language = Language {
    identity: "text/default/parser-none/grammar-none/extractor-2",
    extensions: &[],
    extract,
    is_native: false,
    #[cfg(test)]
    chunking: Chunking::Paragraphs,
};

/// Text snapshots have source coverage but no inferred syntax records.
fn extract(source: SourceFile) -> Result<Analysis> {
    let span = LineIndex::new(&source.text).span(0, source.text.len());
    let source_chunks = crate::retrieval::ts_v2::text_chunks(&source.text, &source.path);
    Ok(Analysis {
        source_chunks,
        source,
        diagnostics: Vec::new(),
        entities: Vec::new(),
        facts: Vec::new(),
        scopes: vec![Scope {
            kind: "file".into(),
            span,
            parent: None,
            owner: None,
        }],
    })
}
