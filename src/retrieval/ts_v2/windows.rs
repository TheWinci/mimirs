use super::Chunk;
use crate::source::normalized::Source;
use anyhow::{Result, ensure};

#[derive(Debug)]
pub struct Window {
    pub chunk: usize,
    pub start: usize,
    pub end: usize,
}

struct Piece {
    start: usize,
    end: usize,
    meaningful: bool,
    prefer_previous: bool,
}

pub fn project(source: &str, chunks: &[Chunk], target: usize) -> Result<Vec<Window>> {
    ensure!(target > 0, "source window target must be positive");
    let normalized = Source::new(source);
    let mut children = vec![Vec::new(); chunks.len()];
    for (id, chunk) in chunks.iter().enumerate() {
        if let Some(parent) = chunk.parent {
            children[parent].push(id);
        }
    }
    let units =
        |raw| -> Result<usize> { normalized.utf16_offset(normalized.normalized_offset(raw)?) };
    let mut output = Vec::new();
    for (root, chunk) in chunks
        .iter()
        .enumerate()
        .filter(|(_, c)| c.parent.is_none() && c.kind != "gap")
    {
        let mut pieces = Vec::new();
        boundary(source, chunks, &children, root, target, &units, &mut pieces)?;
        let mut groups: Vec<Piece> = Vec::new();
        let mut current: Option<Piece> = None;
        let mut whitespace: Option<Piece> = None;
        for piece in pieces {
            let previous = whitespace.as_ref().or(current.as_ref());
            ensure!(
                previous.is_none_or(|p| p.end == piece.start),
                "noncontiguous source-window pieces"
            );
            if !piece.meaningful {
                let start = whitespace.as_ref().map_or(piece.start, |p| p.start);
                whitespace = Some(Piece {
                    start,
                    end: piece.end,
                    meaningful: false,
                    prefer_previous: false,
                });
                continue;
            }
            let start = whitespace.take().map_or(piece.start, |p| p.start);
            if let Some(previous) = current.take() {
                if units(piece.end)? - units(previous.start)? > target && !piece.prefer_previous {
                    groups.push(previous);
                    current = Some(Piece { start, ..piece });
                } else {
                    current = Some(Piece {
                        start: previous.start,
                        end: piece.end,
                        meaningful: true,
                        prefer_previous: previous.prefer_previous && piece.prefer_previous,
                    });
                }
            } else {
                current = Some(Piece { start, ..piece });
            }
        }
        if let Some(mut current) = current {
            if let Some(whitespace) = whitespace {
                current.end = whitespace.end;
            }
            groups.push(current);
        }
        for index in 1..groups.len() {
            let boundary = groups[index].start;
            let start = source[chunk.span.start..boundary]
                .rfind('\n')
                .map_or(chunk.span.start, |i| chunk.span.start + i + 1);
            if start < boundary
                && source[start..boundary].trim().is_empty()
                && start > groups[index - 1].start
            {
                groups[index - 1].end = start;
                groups[index].start = start;
            }
        }
        output.extend(groups.into_iter().map(|p| Window {
            chunk: root,
            start: p.start,
            end: p.end,
        }));
    }
    Ok(output)
}

fn boundary(
    source: &str,
    chunks: &[Chunk],
    children: &[Vec<usize>],
    id: usize,
    target: usize,
    units: &impl Fn(usize) -> Result<usize>,
    output: &mut Vec<Piece>,
) -> Result<()> {
    let chunk = &chunks[id];
    let (start, end) = (chunk.span.start, chunk.span.end);
    if units(end)? - units(start)? <= target {
        output.push(Piece {
            start,
            end,
            meaningful: chunk.kind != "gap" && !source[start..end].trim().is_empty(),
            prefer_previous: false,
        });
    } else if !children[id].is_empty() {
        for &child in &children[id] {
            boundary(source, chunks, children, child, target, units, output)?;
        }
    } else {
        let mut cursor = start;
        for line in source[start..end].split_inclusive('\n') {
            let trimmed = line.trim();
            let without_suffix = trimmed.strip_suffix([';', ',']).unwrap_or(trimmed);
            let prefer_previous = !without_suffix.is_empty()
                && without_suffix
                    .bytes()
                    .all(|b| matches!(b, b'}' | b']' | b')'));
            output.push(Piece {
                start: cursor,
                end: cursor + line.len(),
                meaningful: !trimmed.is_empty(),
                prefer_previous,
            });
            cursor += line.len();
        }
    }
    Ok(())
}
