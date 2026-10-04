use std::ops::Range;
use std::path::Path;

use anyhow::Result;

mod symbols;
mod typescript;

/// Most bytes a line chunk grows to; a longer line stays one chunk. Code uses
/// about 4 bytes per token, so this is close to the model's 256-token limit.
const CHUNK_BYTES: usize = 1_000;

/// Printed where a child's body is left out of its parent's text.
pub const ELISION: &str = "…";

/// A continuous span of a file: what `context` shows and cites. A chunk's own
/// text is its span minus its children's bodies.
pub struct Chunk {
    /// What the span holds: `lines` for line chunks.
    pub kind: String,
    /// The symbol's own name; line chunks have none.
    pub name: Option<String>,
    /// Index of the enclosing chunk in the same list. Parents come before
    /// their children.
    pub parent: Option<usize>,
    pub bytes: Range<usize>,
    /// First line, counting from 1.
    pub start_line: usize,
    /// Last line, inclusive.
    pub end_line: usize,
    /// The part left out of the parent's text, usually the body.
    pub body: Option<Range<usize>>,
}

/// Chunk a file by its symbols when its language has a grammar, and by lines
/// otherwise or when parsing gives no tree.
pub fn chunk_file(path: &str, text: &str) -> Result<Vec<Chunk>> {
    let extension = Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("");
    let rules = match extension {
        "ts" | "mts" | "cts" => Some(&typescript::TYPESCRIPT),
        "tsx" => Some(&typescript::TSX),
        _ => None,
    };
    if let Some(rules) = rules
        && let Some(chunks) = symbols::symbol_chunks(text, rules)?
    {
        return Ok(chunks);
    }
    Ok(line_chunks(text))
}

/// Split `text` into chunks of whole lines, each within `CHUNK_BYTES` unless a
/// single line exceeds it. Lines never overlap between chunks, and chunks of
/// only whitespace are left out.
pub fn line_chunks(text: &str) -> Vec<Chunk> {
    line_chunks_in(text, 0..text.len())
}

/// Like `line_chunks`, for the part of `text` in `region`. The region may start
/// or end in the middle of a line.
fn line_chunks_in(text: &str, region: Range<usize>) -> Vec<Chunk> {
    let mut chunks = Vec::new();
    let mut chunk_start = region.start;
    let mut chunk_end = region.start;
    for line in text[region].split_inclusive('\n') {
        let chunk_is_full =
            chunk_end > chunk_start && chunk_end - chunk_start + line.len() > CHUNK_BYTES;
        if chunk_is_full {
            push_line_chunk(&mut chunks, text, chunk_start..chunk_end);
            chunk_start = chunk_end;
        }
        chunk_end += line.len();
    }
    push_line_chunk(&mut chunks, text, chunk_start..chunk_end);
    chunks
}

// Whitespace has nothing worth embedding; its bytes stay outside every chunk.
fn push_line_chunk(chunks: &mut Vec<Chunk>, text: &str, bytes: Range<usize>) {
    if text[bytes.clone()].trim().is_empty() {
        return;
    }
    chunks.push(Chunk {
        kind: "lines".into(),
        name: None,
        parent: None,
        start_line: line_at(text, bytes.start),
        end_line: last_line(text, bytes.clone()),
        bytes,
        body: None,
    });
}

/// The line, counting from 1, that holds the byte at `offset`.
pub fn line_at(text: &str, offset: usize) -> usize {
    // Counted on bytes, so an offset inside a multi-byte character still works.
    let newlines = text.as_bytes()[..offset]
        .iter()
        .filter(|&&byte| byte == b'\n')
        .count();
    newlines + 1
}

/// The line that holds the last byte of `bytes`.
pub fn last_line(text: &str, bytes: Range<usize>) -> usize {
    line_at(text, bytes.end.saturating_sub(1).max(bytes.start))
}

/// The chunk's own text: its span with each child's body replaced by `ELISION`.
pub fn own_text(text: &str, chunks: &[Chunk], index: usize) -> String {
    let left_out: Vec<Range<usize>> = chunks
        .iter()
        .filter(|chunk| chunk.parent == Some(index))
        .filter_map(|chunk| chunk.body.clone())
        .collect();
    text_without(text, chunks[index].bytes.clone(), &left_out)
}

/// `text[span]` with each range in `left_out` replaced by `ELISION`. The ranges
/// must lie inside `span` and not overlap.
pub fn text_without(text: &str, span: Range<usize>, left_out: &[Range<usize>]) -> String {
    let mut sorted = left_out.to_vec();
    sorted.sort_by_key(|range| range.start);
    let mut result = String::new();
    let mut position = span.start;
    for range in sorted {
        result.push_str(&text[position..range.start]);
        result.push_str(ELISION);
        position = range.end;
    }
    result.push_str(&text[position..span.end]);
    result
}

/// The chunk's name joined with its parents' names, outermost first.
pub fn full_name(chunks: &[Chunk], index: usize) -> Option<String> {
    let mut names = Vec::new();
    let mut current = Some(index);
    while let Some(position) = current {
        if let Some(name) = &chunks[position].name {
            names.push(name.as_str());
        }
        current = chunks[position].parent;
    }
    if names.is_empty() {
        return None;
    }
    names.reverse();
    Some(names.join("."))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk_text<'a>(text: &'a str, chunk: &Chunk) -> &'a str {
        &text[chunk.bytes.clone()]
    }

    #[test]
    fn a_short_file_is_one_chunk() {
        let text = "fn main() {\n    println!(\"hi\");\n}\n";
        let chunks = line_chunks(text);
        assert_eq!(chunks.len(), 1);
        assert_eq!((chunks[0].start_line, chunks[0].end_line), (1, 3));
        assert_eq!(chunk_text(text, &chunks[0]), text);
        assert_eq!(chunks[0].kind, "lines");
    }

    #[test]
    fn chunks_cover_every_line_once_within_the_byte_limit() {
        let text: String = (1..=400)
            .map(|number| format!("let value_{number} = compute({number});\n"))
            .collect();
        let chunks = line_chunks(&text);

        assert!(chunks.len() > 1);
        let joined: String = chunks
            .iter()
            .map(|chunk| chunk_text(&text, chunk))
            .collect();
        assert_eq!(joined, text);
        let mut next_line = 1;
        for chunk in &chunks {
            assert_eq!(chunk.start_line, next_line);
            next_line = chunk.end_line + 1;
            assert!(chunk.bytes.len() <= CHUNK_BYTES);
        }
        assert_eq!(next_line, 401);
    }

    #[test]
    fn a_long_line_stays_one_chunk() {
        let line = "alpha beta gamma delta ".repeat(300) + "\n";
        let chunks = line_chunks(&line);
        assert_eq!(chunks.len(), 1);
        assert_eq!((chunks[0].start_line, chunks[0].end_line), (1, 1));
        assert_eq!(chunk_text(&line, &chunks[0]), line);
    }

    #[test]
    fn files_with_a_grammar_are_chunked_by_symbols() -> Result<()> {
        let text = "function run() {}\n";
        assert_eq!(chunk_file("src/run.ts", text)?[0].kind, "function");
        assert_eq!(chunk_file("src/run.tsx", text)?[0].kind, "function");
        assert_eq!(chunk_file("notes/run.txt", text)?[0].kind, "lines");
        Ok(())
    }

    #[test]
    fn a_chunk_may_end_with_a_multi_byte_character() {
        let text = "// ──\nlet a = 1;\n// ──";
        assert_eq!(last_line(text, 0..text.len()), 3);
        assert_eq!(line_chunks(text)[0].end_line, 3);
    }

    #[test]
    fn a_whitespace_file_has_no_chunks() {
        assert!(line_chunks("").is_empty());
        assert!(line_chunks("\n  \n\t\n").is_empty());
    }

    fn symbol(
        name: &str,
        parent: Option<usize>,
        bytes: Range<usize>,
        body: Option<Range<usize>>,
    ) -> Chunk {
        Chunk {
            kind: "method".into(),
            name: Some(name.into()),
            parent,
            bytes,
            start_line: 1,
            end_line: 1,
            body,
        }
    }

    #[test]
    fn a_parent_keeps_its_childrens_declarations_but_not_their_bodies() {
        let text = "class Queue { push() { a(); } size() { b(); } }";
        let chunks = [
            symbol("Queue", None, 0..text.len(), Some(12..text.len())),
            symbol("push", Some(0), 14..29, Some(21..29)),
            symbol("size", Some(0), 30..45, Some(37..45)),
        ];
        assert_eq!(
            own_text(text, &chunks, 0),
            "class Queue { push() … size() … }"
        );
        assert_eq!(own_text(text, &chunks, 1), "push() { a(); }");
        assert_eq!(full_name(&chunks, 2).as_deref(), Some("Queue.size"));
    }
}
