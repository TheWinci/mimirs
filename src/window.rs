use crate::chunk::Chunk;

#[derive(Debug, PartialEq, Eq)]
pub struct Window<'chunk, 'source> {
    pub chunk: &'chunk Chunk<'source>,
    pub text: String,
}

pub fn of<'chunk, 'source>(chunk: &'chunk Chunk<'source>) -> Vec<Window<'chunk, 'source>> {
    chunk
        .text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| Window {
            chunk,
            text: line.to_owned(),
        })
        .collect()
}

#[cfg(test)]
#[path = "../tests/unit/window.rs"]
mod tests;
