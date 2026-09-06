use anyhow::Result;

use super::language::{Chunking, Language};
use super::{Analysis, LineIndex, Scope};
use crate::source::SourceFile;

pub(super) const LANGUAGE: Language = Language {
    identity: "text/default/parser-none/grammar-none/extractor-1",
    extensions: &[],
    extract,
    chunking: Chunking::Paragraphs,
};

/// Text snapshots have source coverage but no inferred syntax records.
fn extract(source: SourceFile) -> Result<Analysis> {
    let span = LineIndex::new(&source.text).span(0, source.text.len());
    Ok(Analysis {
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
