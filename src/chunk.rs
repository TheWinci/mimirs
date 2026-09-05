use crate::source::SourceFile;

#[derive(Debug, PartialEq, Eq)]
pub struct Chunk<'source> {
    pub source: &'source SourceFile,
    pub text: String,
    pub byte_start: usize,
    pub byte_end: usize,
    pub line_start: usize,
    pub line_end: usize,
}

pub fn of(source: &SourceFile) -> Vec<Chunk<'_>> {
    vec![Chunk {
        source,
        text: source.text.clone(),
        byte_start: 0,
        byte_end: source.text.len(),
        line_start: 1,
        line_end: source.text.lines().count().max(1),
    }]
}

#[cfg(test)]
#[path = "../tests/unit/chunk.rs"]
mod tests;
