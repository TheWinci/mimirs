use anyhow::Result;
use tokenizers::Tokenizer;

use crate::embed::MAX_TOKENS;

/// Tokens a window may hold besides the model's two special tokens.
const WINDOW_TOKENS: usize = MAX_TOKENS - 2;

/// A range of whole lines: what `context` shows and cites.
pub struct Chunk {
    /// First line, counting from 1.
    pub start_line: usize,
    /// Last line, inclusive.
    pub end_line: usize,
    pub text: String,
    pub windows: Vec<Window>,
}

/// A byte range of a chunk's text that fits the model: what gets embedded.
pub struct Window {
    pub start: usize,
    pub end: usize,
}

impl Chunk {
    pub fn window_text(&self, window: &Window) -> &str {
        &self.text[window.start..window.end]
    }
}

/// Split `text` into chunks of whole lines, each within the model's token limit
/// unless a single line exceeds it. Lines never overlap between chunks.
pub fn chunk(text: &str, tokenizer: &Tokenizer) -> Result<Vec<Chunk>> {
    let mut chunks = Vec::new();
    let mut chunk_text = String::new();
    let mut chunk_tokens = 0;
    let mut start_line = 1;
    let mut last_line = 0;

    for (index, line) in text.split_inclusive('\n').enumerate() {
        let line_number = index + 1;
        let line_tokens = count_tokens(line, tokenizer)?;
        let chunk_is_full = chunk_tokens > 0 && chunk_tokens + line_tokens > WINDOW_TOKENS;
        if chunk_is_full {
            chunks.push(finish(start_line, last_line, chunk_text, tokenizer)?);
            chunk_text = String::new();
            chunk_tokens = 0;
            start_line = line_number;
        }
        chunk_text.push_str(line);
        chunk_tokens += line_tokens;
        last_line = line_number;
    }
    // A file of only whitespace has nothing worth embedding.
    if chunk_tokens > 0 {
        chunks.push(finish(start_line, last_line, chunk_text, tokenizer)?);
    }
    Ok(chunks)
}

fn count_tokens(text: &str, tokenizer: &Tokenizer) -> Result<usize> {
    let encoding = tokenizer.encode(text, false).map_err(anyhow::Error::msg)?;
    Ok(encoding.len())
}

fn finish(
    start_line: usize,
    end_line: usize,
    text: String,
    tokenizer: &Tokenizer,
) -> Result<Chunk> {
    let windows = split_into_windows(&text, tokenizer)?;
    Ok(Chunk {
        start_line,
        end_line,
        text,
        windows,
    })
}

/// Cut the text at token boundaries every `WINDOW_TOKENS` tokens.
fn split_into_windows(text: &str, tokenizer: &Tokenizer) -> Result<Vec<Window>> {
    let encoding = tokenizer.encode(text, false).map_err(anyhow::Error::msg)?;
    // Byte offsets of each token in `text`.
    let offsets = encoding.get_offsets();

    let mut windows = Vec::new();
    let mut start = 0;
    for token_index in (WINDOW_TOKENS..offsets.len()).step_by(WINDOW_TOKENS) {
        let (cut, _) = offsets[token_index];
        windows.push(Window { start, end: cut });
        start = cut;
    }
    windows.push(Window {
        start,
        end: text.len(),
    });
    Ok(windows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::embed::load_tokenizer;
    use std::path::Path;

    fn tokenizer() -> Result<Tokenizer> {
        load_tokenizer(&Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/tokenizer.json"))
    }

    #[test]
    fn a_short_file_is_one_chunk_with_one_window() -> Result<()> {
        let text = "fn main() {\n    println!(\"hi\");\n}\n";
        let chunks = chunk(text, &tokenizer()?)?;
        assert_eq!(chunks.len(), 1);
        assert_eq!((chunks[0].start_line, chunks[0].end_line), (1, 3));
        assert_eq!(chunks[0].text, text);
        assert_eq!(chunks[0].windows.len(), 1);
        Ok(())
    }

    #[test]
    fn chunks_cover_every_line_once_within_the_token_limit() -> Result<()> {
        let tokenizer = tokenizer()?;
        let text: String = (1..=400)
            .map(|number| format!("let value_{number} = compute({number});\n"))
            .collect();
        let chunks = chunk(&text, &tokenizer)?;

        assert!(chunks.len() > 1);
        let joined: String = chunks.iter().map(|chunk| chunk.text.as_str()).collect();
        assert_eq!(joined, text);
        let mut next_line = 1;
        for chunk in &chunks {
            assert_eq!(chunk.start_line, next_line);
            next_line = chunk.end_line + 1;
            assert!(count_tokens(&chunk.text, &tokenizer)? <= WINDOW_TOKENS + 2);
        }
        assert_eq!(next_line, 401);
        Ok(())
    }

    #[test]
    fn a_long_line_stays_one_chunk_with_several_windows() -> Result<()> {
        let tokenizer = tokenizer()?;
        let line = "alpha beta gamma delta ".repeat(300) + "\n";
        let chunks = chunk(&line, &tokenizer)?;

        assert_eq!(chunks.len(), 1);
        let long_chunk = &chunks[0];
        assert_eq!((long_chunk.start_line, long_chunk.end_line), (1, 1));
        assert!(long_chunk.windows.len() > 1);
        let joined: String = long_chunk
            .windows
            .iter()
            .map(|window| long_chunk.window_text(window))
            .collect();
        assert_eq!(joined, line);
        for window in &long_chunk.windows {
            assert!(count_tokens(long_chunk.window_text(window), &tokenizer)? <= WINDOW_TOKENS);
        }
        Ok(())
    }

    #[test]
    fn a_whitespace_file_has_no_chunks() -> Result<()> {
        assert!(chunk("", &tokenizer()?)?.is_empty());
        assert!(chunk("\n  \n\t\n", &tokenizer()?)?.is_empty());
        Ok(())
    }
}
