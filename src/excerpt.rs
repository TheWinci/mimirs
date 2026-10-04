use std::ops::Range;

use crate::chunk::text_without;
use crate::store::StoredFile;

/// Consecutive lines of one file, made of one chunk or touching chunks.
pub struct Excerpt {
    pub start_line: usize,
    pub end_line: usize,
    pub text: String,
}

/// A file as `context` shows it: a summary line for the map and its excerpts in
/// line order.
pub struct ShownFile {
    pub path: String,
    /// Line number and text of the first non-blank line of the best chunk.
    pub summary_line: usize,
    pub summary: String,
    pub excerpts: Vec<Excerpt>,
}

/// Build what `context` shows for a file from its matching chunks, best first.
pub fn show_file(path: &str, file: &StoredFile, matched_ids: &[i64]) -> ShownFile {
    let matched: Vec<usize> = matched_ids
        .iter()
        .filter_map(|id| file.chunk_ids.iter().position(|chunk_id| chunk_id == id))
        .collect();
    let (summary_line, summary) = match matched.first() {
        Some(&best) => first_non_blank_line(&file.text, file.chunks[best].bytes.clone()),
        None => (1, String::new()),
    };
    ShownFile {
        path: path.to_string(),
        summary_line,
        summary,
        excerpts: excerpts(file, &matched),
    }
}

/// Merge the matched chunks' spans where they touch, overlap, or have only
/// whitespace between them, and print each merged span with the bodies of
/// unmatched children left out.
fn excerpts(file: &StoredFile, matched: &[usize]) -> Vec<Excerpt> {
    let text = &file.text;
    let mut spans: Vec<Range<usize>> = matched
        .iter()
        .map(|&index| from_line_start(text, file.chunks[index].bytes.clone()))
        .collect();
    spans.sort_by_key(|span| span.start);

    let mut merged: Vec<Range<usize>> = Vec::new();
    for span in spans {
        match merged.last_mut() {
            Some(previous)
                if text[previous.end.min(span.start)..span.start]
                    .trim()
                    .is_empty() =>
            {
                previous.end = previous.end.max(span.end);
            }
            _ => merged.push(span),
        }
    }

    let left_out = left_out_bodies(file, matched);
    merged
        .into_iter()
        .map(|span| {
            let inside: Vec<Range<usize>> = left_out
                .iter()
                .filter(|body| body.start >= span.start && body.end <= span.end)
                .cloned()
                .collect();
            Excerpt {
                start_line: line_at(text, span.start),
                end_line: line_at(text, span.end.saturating_sub(1).max(span.start)),
                text: text_without(text, span, &inside),
            }
        })
        .collect()
}

/// Bodies to leave out: those of unmatched chunks whose parent matched, unless
/// a matched chunk sits inside the body.
fn left_out_bodies(file: &StoredFile, matched: &[usize]) -> Vec<Range<usize>> {
    let mut bodies = Vec::new();
    for (index, chunk) in file.chunks.iter().enumerate() {
        let parent_matched = chunk.parent.is_some_and(|parent| matched.contains(&parent));
        let Some(body) = &chunk.body else {
            continue;
        };
        if !parent_matched || matched.contains(&index) {
            continue;
        }
        let holds_a_match = matched.iter().any(|&other| {
            let bytes = &file.chunks[other].bytes;
            bytes.start >= body.start && bytes.end <= body.end
        });
        if !holds_a_match {
            bodies.push(body.clone());
        }
    }
    bodies
}

/// Start the span at its line's start when only indentation comes before it.
fn from_line_start(text: &str, span: Range<usize>) -> Range<usize> {
    let line_start = text[..span.start]
        .rfind('\n')
        .map_or(0, |newline| newline + 1);
    if text[line_start..span.start].trim().is_empty() {
        line_start..span.end
    } else {
        span
    }
}

/// The line, counting from 1, that holds the byte at `offset`.
fn line_at(text: &str, offset: usize) -> usize {
    text[..offset].matches('\n').count() + 1
}

fn first_non_blank_line(text: &str, span: Range<usize>) -> (usize, String) {
    let first_line = line_at(text, span.start);
    for (offset, line) in text[span.clone()].lines().enumerate() {
        if !line.trim().is_empty() {
            return (first_line + offset, line.trim().to_string());
        }
    }
    (first_line, String::new())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chunk::Chunk;

    fn chunk(
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

    // Lines: 1 `class Queue {`, 2 `  push() { a(); }`, 3 `  size() { b(); }`, 4 `}`.
    const QUEUE: &str = "class Queue {\n  push() { a(); }\n  size() { b(); }\n}\n";

    fn queue_file() -> StoredFile {
        StoredFile {
            text: QUEUE.into(),
            chunk_ids: vec![10, 11, 12],
            chunks: vec![
                chunk("Queue", None, 0..51, Some(12..51)),
                chunk("push", Some(0), 16..31, Some(23..31)),
                chunk("size", Some(0), 34..49, Some(41..49)),
            ],
        }
    }

    #[test]
    fn a_matched_method_shows_whole_from_its_line_start() {
        let shown = show_file("queue.ts", &queue_file(), &[11]);
        assert_eq!(shown.excerpts.len(), 1);
        let excerpt = &shown.excerpts[0];
        assert_eq!((excerpt.start_line, excerpt.end_line), (2, 2));
        assert_eq!(excerpt.text, "  push() { a(); }");
        assert_eq!(
            (shown.summary_line, shown.summary.as_str()),
            (2, "push() { a(); }")
        );
    }

    #[test]
    fn a_matched_class_shows_its_outline() {
        let shown = show_file("queue.ts", &queue_file(), &[10]);
        assert_eq!(
            shown.excerpts[0].text,
            "class Queue {\n  push() …\n  size() …\n}"
        );
        assert_eq!(
            (shown.excerpts[0].start_line, shown.excerpts[0].end_line),
            (1, 4)
        );
    }

    #[test]
    fn a_matched_method_inside_a_matched_class_keeps_its_body() {
        let shown = show_file("queue.ts", &queue_file(), &[10, 12]);
        assert_eq!(shown.excerpts.len(), 1);
        assert_eq!(
            shown.excerpts[0].text,
            "class Queue {\n  push() …\n  size() { b(); }\n}"
        );
    }

    #[test]
    fn chunks_with_only_whitespace_between_them_merge() {
        let shown = show_file("queue.ts", &queue_file(), &[12, 11]);
        assert_eq!(shown.excerpts.len(), 1);
        assert_eq!(
            shown.excerpts[0].text,
            "  push() { a(); }\n  size() { b(); }"
        );
        assert_eq!(
            (shown.excerpts[0].start_line, shown.excerpts[0].end_line),
            (2, 3)
        );
    }
}
