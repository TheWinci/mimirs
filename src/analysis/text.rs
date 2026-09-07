use anyhow::Result;

#[cfg(test)]
use super::language::Chunking;
use super::language::Language;
use super::{Analysis, LineIndex};
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
    let lines = LineIndex::new(&source.text);
    let mut analysis = Analysis::new(source, &lines);
    analysis.source_chunks =
        crate::retrieval::ts_v2::text_chunks(&analysis.source.text, &analysis.source.path);
    Ok(analysis)
}
