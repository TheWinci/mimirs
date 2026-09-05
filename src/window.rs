use crate::chunk::Chunk;

#[derive(Debug, PartialEq, Eq)]
pub struct Window<'a> {
    pub chunk: &'a Chunk<'a>,
    pub text: String,
}

pub fn of<'a>(chunk: &'a Chunk<'a>) -> Vec<Window<'a>> {
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
