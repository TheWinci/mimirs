use std::ops::{ControlFlow, Range};
use std::time::{Duration, Instant};

use anyhow::Result;
use tree_sitter::{Language, Node, ParseOptions, ParseState, Parser, Tree};

use super::{Chunk, last_line, line_at, line_chunks_in};

/// A file whose parse takes longer than this falls back to line chunks.
const PARSE_TIME_LIMIT: Duration = Duration::from_secs(2);

/// How one language's syntax tree turns into symbols.
pub struct Rules {
    pub grammar: fn() -> Language,
    /// Recognizes a node that is a symbol.
    pub symbol: for<'tree> fn(Node<'tree>, &str) -> Option<Symbol<'tree>>,
    /// Recognizes an import; consecutive imports form one chunk.
    pub is_import: fn(Node, &str) -> bool,
}

/// What a language says about a node that is a symbol. The symbol's span is the
/// node itself.
pub struct Symbol<'tree> {
    pub kind: &'static str,
    /// Empty for symbols without a name, such as `export default () => {}`.
    pub name: String,
    /// The part left out of the parent's text, usually the body.
    pub body: Option<Range<usize>>,
    /// The node whose children hold this symbol's own symbols, such as a class
    /// body. Function bodies are never searched for symbols.
    pub members: Option<Node<'tree>>,
}

/// Chunk `text` by its symbols. Returns `None` when tree-sitter gives no tree,
/// so the caller falls back to line chunks.
pub fn symbol_chunks(text: &str, rules: &Rules) -> Result<Option<Vec<Chunk>>> {
    let language = (rules.grammar)();
    let Some(tree) = parse(text, &language)? else {
        return Ok(None);
    };
    let mut chunks = Vec::new();
    let root = tree.root_node();
    collect_symbols(root, None, text, rules, &mut chunks);
    add_top_level_rest(root, text, rules, &mut chunks);
    Ok(Some(chunks))
}

fn parse(text: &str, language: &Language) -> Result<Option<Tree>> {
    let mut parser = Parser::new();
    parser.set_language(language)?;
    let started = Instant::now();
    let mut stop_after_limit = |_: &ParseState| {
        if started.elapsed() > PARSE_TIME_LIMIT {
            ControlFlow::Break(())
        } else {
            ControlFlow::Continue(())
        }
    };
    let options = ParseOptions::new().progress_callback(&mut stop_after_limit);
    let bytes = text.as_bytes();
    let mut read = |offset: usize, _| &bytes[offset..];
    Ok(parser.parse_with_options(&mut read, None, Some(options)))
}

/// Add a chunk for each symbol among `container`'s children, then for the
/// symbols among each symbol's members.
fn collect_symbols(
    container: Node,
    parent: Option<usize>,
    text: &str,
    rules: &Rules,
    chunks: &mut Vec<Chunk>,
) {
    let mut cursor = container.walk();
    for node in container.named_children(&mut cursor) {
        if (rules.is_import)(node, text) {
            continue;
        }
        let Some(symbol) = (rules.symbol)(node, text) else {
            continue;
        };
        let start = attached_comments_start(node);
        let bytes = start..node.end_byte();
        chunks.push(Chunk {
            kind: symbol.kind.into(),
            name: (!symbol.name.is_empty()).then_some(symbol.name),
            parent,
            start_line: line_at(text, bytes.start),
            end_line: last_line(text, bytes.clone()),
            bytes,
            body: symbol.body,
        });
        if let Some(members) = symbol.members {
            let index = chunks.len() - 1;
            collect_symbols(members, Some(index), text, rules, chunks);
        }
    }
}

/// Where a symbol starts once the comments right above it are included: each
/// comment must end on the line just before the next one starts.
fn attached_comments_start(node: Node) -> usize {
    let mut start = node.start_byte();
    let mut next_row = node.start_position().row;
    let mut previous = node.prev_named_sibling();
    while let Some(comment) = previous {
        let touches = comment.end_position().row + 1 >= next_row;
        if !comment.kind().contains("comment") || !touches {
            break;
        }
        start = comment.start_byte();
        next_row = comment.start_position().row;
        previous = comment.prev_named_sibling();
    }
    start
}

/// Add one chunk for each run of consecutive imports, and line chunks for the
/// remaining top-level code that is neither a symbol nor an import.
fn add_top_level_rest(root: Node, text: &str, rules: &Rules, chunks: &mut Vec<Chunk>) {
    let mut imports: Vec<Range<usize>> = Vec::new();
    let mut cursor = root.walk();
    for node in root.named_children(&mut cursor) {
        if !(rules.is_import)(node, text) {
            continue;
        }
        let start = attached_comments_start(node);
        match imports.last_mut() {
            Some(run) if text[run.end..start].trim().is_empty() => run.end = node.end_byte(),
            _ => imports.push(start..node.end_byte()),
        }
    }
    for bytes in imports {
        chunks.push(Chunk {
            kind: "imports".into(),
            name: None,
            parent: None,
            start_line: line_at(text, bytes.start),
            end_line: last_line(text, bytes.clone()),
            bytes,
            body: None,
        });
    }

    let mut covered: Vec<Range<usize>> = chunks
        .iter()
        .filter(|chunk| chunk.parent.is_none())
        .map(|chunk| chunk.bytes.clone())
        .collect();
    covered.sort_by_key(|bytes| bytes.start);
    let mut position = 0;
    let mut rest = Vec::new();
    for bytes in covered {
        if bytes.start > position {
            rest.push(position..bytes.start);
        }
        position = position.max(bytes.end);
    }
    rest.push(position..text.len());
    for region in rest {
        chunks.extend(line_chunks_in(text, trimmed(text, region)));
    }
}

/// `region` without the whitespace at its start and end.
fn trimmed(text: &str, region: Range<usize>) -> Range<usize> {
    let slice = &text[region.clone()];
    let start = region.start + (slice.len() - slice.trim_start().len());
    let end = region.end - (slice.len() - slice.trim_end().len());
    start..end.max(start)
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::chunk::full_name;

    /// One line per chunk, parents before children: kind, full name, lines.
    pub fn outline(chunks: &[Chunk]) -> String {
        chunks
            .iter()
            .enumerate()
            .map(|(index, chunk)| {
                let name = full_name(chunks, index).unwrap_or_else(|| "-".into());
                format!(
                    "{} {} {}-{}\n",
                    chunk.kind, name, chunk.start_line, chunk.end_line
                )
            })
            .collect()
    }

    /// The rules every chunking must keep (D17, D19).
    pub fn check_invariants(text: &str, chunks: &[Chunk]) {
        for (index, chunk) in chunks.iter().enumerate() {
            let bytes = &chunk.bytes;
            assert!(
                bytes.start < bytes.end && bytes.end <= text.len(),
                "chunk {index} out of the file"
            );
            assert_eq!(
                chunk.start_line,
                line_at(text, bytes.start),
                "chunk {index} start line"
            );
            assert_eq!(
                chunk.end_line,
                last_line(text, bytes.clone()),
                "chunk {index} end line"
            );
            if let Some(body) = &chunk.body {
                assert!(
                    body.start >= bytes.start && body.end <= bytes.end,
                    "chunk {index} body outside its span"
                );
            }
            if let Some(parent) = chunk.parent {
                assert!(parent < index, "chunk {index} comes before its parent");
                let parent_bytes = &chunks[parent].bytes;
                assert!(
                    bytes.start >= parent_bytes.start && bytes.end <= parent_bytes.end,
                    "chunk {index} outside its parent"
                );
            }
        }
        // Siblings never overlap.
        for (index, chunk) in chunks.iter().enumerate() {
            for other in &chunks[index + 1..] {
                if other.parent == chunk.parent {
                    let apart = chunk.bytes.end <= other.bytes.start
                        || other.bytes.end <= chunk.bytes.start;
                    assert!(
                        apart,
                        "chunks overlap: {:?} and {:?}",
                        chunk.bytes, other.bytes
                    );
                }
            }
        }
        // Every byte outside top-level chunks is whitespace.
        let mut covered = vec![false; text.len()];
        for chunk in chunks.iter().filter(|chunk| chunk.parent.is_none()) {
            for flag in &mut covered[chunk.bytes.clone()] {
                *flag = true;
            }
        }
        for (offset, character) in text.char_indices() {
            assert!(
                covered[offset] || character.is_whitespace(),
                "byte {offset} ({character:?}) is in no chunk"
            );
        }
    }
}
