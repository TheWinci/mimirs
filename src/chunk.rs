/// Most bytes a line chunk grows to; a longer line stays one chunk. Code uses
/// about 4 bytes per token, so this is close to the model's 256-token limit.
const CHUNK_BYTES: usize = 1_000;

/// A range of whole lines: what `context` shows and cites.
pub struct Chunk {
    /// First line, counting from 1.
    pub start_line: usize,
    /// Last line, inclusive.
    pub end_line: usize,
    pub text: String,
}

/// Split `text` into chunks of whole lines, each within `CHUNK_BYTES` unless a
/// single line exceeds it. Lines never overlap between chunks, and chunks of
/// only whitespace are left out.
pub fn chunk(text: &str) -> Vec<Chunk> {
    let mut chunks = Vec::new();
    let mut chunk_text = String::new();
    let mut start_line = 1;

    for (index, line) in text.split_inclusive('\n').enumerate() {
        let line_number = index + 1;
        let chunk_is_full = !chunk_text.is_empty() && chunk_text.len() + line.len() > CHUNK_BYTES;
        if chunk_is_full {
            push_unless_blank(&mut chunks, start_line, line_number - 1, chunk_text);
            chunk_text = String::new();
            start_line = line_number;
        }
        chunk_text.push_str(line);
    }
    let last_line = text.split_inclusive('\n').count();
    push_unless_blank(&mut chunks, start_line, last_line, chunk_text);
    chunks
}

// Whitespace has nothing worth embedding.
fn push_unless_blank(chunks: &mut Vec<Chunk>, start_line: usize, end_line: usize, text: String) {
    if !text.trim().is_empty() {
        chunks.push(Chunk {
            start_line,
            end_line,
            text,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_short_file_is_one_chunk() {
        let text = "fn main() {\n    println!(\"hi\");\n}\n";
        let chunks = chunk(text);
        assert_eq!(chunks.len(), 1);
        assert_eq!((chunks[0].start_line, chunks[0].end_line), (1, 3));
        assert_eq!(chunks[0].text, text);
    }

    #[test]
    fn chunks_cover_every_line_once_within_the_byte_limit() {
        let text: String = (1..=400)
            .map(|number| format!("let value_{number} = compute({number});\n"))
            .collect();
        let chunks = chunk(&text);

        assert!(chunks.len() > 1);
        let joined: String = chunks.iter().map(|chunk| chunk.text.as_str()).collect();
        assert_eq!(joined, text);
        let mut next_line = 1;
        for chunk in &chunks {
            assert_eq!(chunk.start_line, next_line);
            next_line = chunk.end_line + 1;
            assert!(chunk.text.len() <= CHUNK_BYTES);
        }
        assert_eq!(next_line, 401);
    }

    #[test]
    fn a_long_line_stays_one_chunk() {
        let line = "alpha beta gamma delta ".repeat(300) + "\n";
        let chunks = chunk(&line);
        assert_eq!(chunks.len(), 1);
        assert_eq!((chunks[0].start_line, chunks[0].end_line), (1, 1));
        assert_eq!(chunks[0].text, line);
    }

    #[test]
    fn a_whitespace_file_has_no_chunks() {
        assert!(chunk("").is_empty());
        assert!(chunk("\n  \n\t\n").is_empty());
    }
}
