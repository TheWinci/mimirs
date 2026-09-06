//! Static language selection shared by analysis, retrieval, and persistence.
use anyhow::Result;
use std::path::Path;

use super::Analysis;
use crate::source::SourceFile;

#[derive(Clone, Copy)]
pub struct DeclarationRules {
    pub containers: &'static [&'static str],
    pub leading_facts: &'static [&'static str],
    pub signature_fact: &'static str,
}

#[derive(Clone, Copy)]
pub enum Chunking {
    Paragraphs,
    Declarations(DeclarationRules),
}

#[derive(Clone, Copy)]
pub struct Language {
    /// Language/dialect, parser, grammar, and extraction revision. Bump when
    /// analysis or language-owned chunk rules change persisted output.
    pub identity: &'static str,
    pub extensions: &'static [&'static str],
    pub extract: fn(SourceFile) -> Result<Analysis>,
    pub chunking: Chunking,
}

const REGISTERED: &[Language] = &[super::rust::LANGUAGE, super::python::LANGUAGE];

pub fn for_path(path: &str) -> &'static Language {
    select(path, REGISTERED)
}

fn select<'a>(path: &str, registered: &'a [Language]) -> &'a Language {
    let extension = Path::new(path).extension().and_then(|ext| ext.to_str());
    registered
        .iter()
        .find(|language| extension.is_some_and(|ext| language.extensions.contains(&ext)))
        .unwrap_or(&super::text::LANGUAGE)
}

/// Extension mappings are part of compatibility: registering a formerly text
/// extension changes document ownership even when its source is unchanged.
pub fn registry_identity() -> String {
    identity(REGISTERED)
}

fn identity(registered: &[Language]) -> String {
    let entries: Vec<_> = registered
        .iter()
        .chain(std::iter::once(&super::text::LANGUAGE))
        .map(|language| (language.extensions, language.identity))
        .collect();
    format!(
        "analyzers-1:{}",
        serde_json::to_string(&entries).expect("string metadata")
    )
}

#[cfg(test)]
#[path = "../../tests/unit/language.rs"]
mod tests;
