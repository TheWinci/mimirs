use std::ops::Range;

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

/// Split `text` into chunks of whole lines, each within `CHUNK_BYTES` unless a
/// single line exceeds it. Lines never overlap between chunks, and chunks of
/// only whitespace are left out.
pub fn line_chunks(text: &str) -> Vec<Chunk> {
    let mut chunks = Vec::new();
    let mut chunk_start = 0;
    let mut chunk_end = 0;
    let mut start_line = 1;

    for (index, line) in text.split_inclusive('\n').enumerate() {
        let line_number = index + 1;
        let chunk_is_full =
            chunk_end > chunk_start && chunk_end - chunk_start + line.len() > CHUNK_BYTES;
        if chunk_is_full {
            push_line_chunk(
                &mut chunks,
                text,
                chunk_start..chunk_end,
                start_line,
                line_number - 1,
            );
            chunk_start = chunk_end;
            start_line = line_number;
        }
        chunk_end += line.len();
    }
    let last_line = text.split_inclusive('\n').count();
    push_line_chunk(
        &mut chunks,
        text,
        chunk_start..chunk_end,
        start_line,
        last_line,
    );
    chunks
}

// Whitespace has nothing worth embedding; its bytes stay outside every chunk.
fn push_line_chunk(
    chunks: &mut Vec<Chunk>,
    text: &str,
    bytes: Range<usize>,
    start_line: usize,
    end_line: usize,
) {
    if text[bytes.clone()].trim().is_empty() {
        return;
    }
    chunks.push(Chunk {
        kind: "lines".into(),
        name: None,
        parent: None,
        bytes,
        start_line,
        end_line,
        body: None,
    });
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
