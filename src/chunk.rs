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
        line_end: last_source_line(&source.text),
    }]
}

fn last_source_line(text: &str) -> usize {
    let bytes_before_last = &text.as_bytes()[..text.len().saturating_sub(1)];
    1 + bytes_before_last
        .iter()
        .filter(|&&byte| byte == b'\n')
        .count()
}

#[cfg(test)]
#[path = "../tests/unit/chunk.rs"]
mod tests;
