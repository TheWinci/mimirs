use super::{TreeChunk, line_starts};
use regex::Regex;
use std::sync::LazyLock;

static FENCE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^ {0,3}(`{3,}|~{3,})").unwrap());
static ATX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$").unwrap());
static SETEXT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^ {0,3}(=+|-+)\s*$").unwrap());
static NOT_SETEXT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^ {0,3}[-*_>#]").unwrap());

struct Heading {
    level: usize,
    name: String,
    start: usize,
}

pub(super) fn chunks(source: &str) -> Vec<TreeChunk> {
    if source.is_empty() {
        return Vec::new();
    }
    let lines: Vec<_> = source.split('\n').collect();
    let starts = line_starts(source);
    let front_end = if lines[0].trim_end() == "---" {
        lines
            .iter()
            .enumerate()
            .skip(1)
            .find(|(_, l)| l.trim_end() == "---")
            .map(|(i, _)| i)
    } else {
        None
    };
    let mut fence: Option<(u8, usize)> = None;
    let mut headings = Vec::new();
    let mut row = 0;
    while row < lines.len() {
        let line = lines[row];
        if front_end.is_some_and(|end| row <= end) {
            row += 1;
            continue;
        }
        if let Some(m) = FENCE.captures(line) {
            let marker = &m[1];
            let character = marker.as_bytes()[0];
            match fence {
                None => fence = Some((character, marker.len())),
                Some((c, len)) if c == character && marker.len() >= len => fence = None,
                _ => (),
            }
            row += 1;
            continue;
        }
        if fence.is_some() {
            row += 1;
            continue;
        }
        if let Some(m) = ATX.captures(line) {
            headings.push(Heading {
                level: m[1].len(),
                name: m[2].trim().into(),
                start: starts[row],
            });
        } else if let Some(next) = lines.get(row + 1)
            && !line.trim().is_empty()
            && !NOT_SETEXT.is_match(line)
            && SETEXT.is_match(next)
        {
            headings.push(Heading {
                level: if next.trim().starts_with('=') { 1 } else { 2 },
                name: line.trim().into(),
                start: starts[row],
            });
            row += 1;
        }
        row += 1;
    }
    if headings.is_empty() {
        return vec![TreeChunk::new("paragraph", None, 0, source.len())];
    }
    sections(source, &headings, 0, 0, source.len())
}

fn body_kind(source: &str, start: usize, end: usize) -> &'static str {
    if source[start..end].trim().is_empty() {
        "gap"
    } else {
        "block"
    }
}

fn sections(
    source: &str,
    headings: &[Heading],
    from: usize,
    start: usize,
    end: usize,
) -> Vec<TreeChunk> {
    let mut chunks = Vec::new();
    let mut cursor = start;
    let mut i = from;
    if let Some(first) = headings.get(i)
        && first.start > cursor
    {
        chunks.push(TreeChunk::new(
            if from == 0 {
                "paragraph"
            } else {
                body_kind(source, cursor, first.start)
            },
            None,
            cursor,
            first.start,
        ));
        cursor = first.start;
    } else if i >= headings.len() && cursor < end {
        return vec![TreeChunk::new(
            if from == 0 {
                "paragraph"
            } else {
                body_kind(source, cursor, end)
            },
            None,
            cursor,
            end,
        )];
    }
    while i < headings.len() && headings[i].start < end {
        let heading = &headings[i];
        let mut j = i + 1;
        while j < headings.len() && headings[j].level > heading.level {
            j += 1;
        }
        let section_end = headings.get(j).map_or(end, |h| h.start.min(end));
        let mut chunk = TreeChunk::new(
            "section",
            Some(heading.name.clone()),
            heading.start,
            section_end,
        );
        if i + 1 < j && headings[i + 1].start < section_end {
            chunk.children = sections(source, headings, i + 1, heading.start, section_end);
        }
        chunks.push(chunk);
        cursor = section_end;
        i = j;
    }
    if cursor < end {
        chunks.push(TreeChunk::new(
            body_kind(source, cursor, end),
            None,
            cursor,
            end,
        ));
    }
    chunks
}
