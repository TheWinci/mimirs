use super::*;
use anyhow::Result;
use regex::{Captures, Regex};
use std::{collections::HashMap, ops::Range};

struct Destinations {
    escape: Regex,
    named: Regex,
    decimal: Regex,
    hex: Regex,
}

impl Destinations {
    fn new() -> Result<Self> {
        Ok(Self {
            escape: Regex::new(r##"\\([!"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~])"##)?,
            named: Regex::new(r"(?i)&(amp|lt|gt|quot|apos);")?,
            decimal: Regex::new(r"&#(\d+);")?,
            hex: Regex::new(r"(?i)&#x([\da-f]+);")?,
        })
    }

    fn destination(&self, value: &str) -> Option<String> {
        let Self {
            escape,
            named,
            decimal,
            hex,
        } = self;
        let value = escape.replace_all(value.trim(), "$1");
        let value = named.replace_all(&value, |c: &Captures<'_>| {
            match c[1].to_lowercase().as_str() {
                "amp" => "&",
                "lt" => "<",
                "gt" => ">",
                "quot" => "\"",
                _ => "'",
            }
        });
        let decode = |digits: &str, radix| {
            u32::from_str_radix(digits, radix)
                .ok()
                .filter(|&value| value != 0)
                .and_then(char::from_u32)
                .unwrap_or('\u{fffd}')
                .to_string()
        };
        let value = decimal.replace_all(&value, |c: &Captures<'_>| decode(&c[1], 10));
        let value = hex.replace_all(&value, |c: &Captures<'_>| decode(&c[1], 16));
        let lower = value.to_lowercase();
        (!value.is_empty()
            && !value.starts_with('#')
            && !["data:", "javascript:", "mailto:", "tel:"]
                .iter()
                .any(|prefix| lower.starts_with(prefix))
            && !["{{", "}}", "${", "<%", "%>"]
                .iter()
                .any(|part| value.contains(part)))
        .then(|| value.into_owned())
    }
}

fn label(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}
fn contains(ranges: &[Range<usize>], offset: usize) -> bool {
    ranges.iter().any(|range| range.contains(&offset))
}

fn code_ranges(source: &str) -> Result<Vec<Range<usize>>> {
    let pattern = Regex::new(r"^ {0,3}(`{3,}|~{3,})")?;
    let mut ranges = Vec::new();
    let mut fence: Option<(u8, usize, usize)> = None;
    let mut offset = 0;
    for line in source.split_inclusive('\n') {
        if let Some(captures) = pattern.captures(line) {
            let marker = &captures[1];
            if let Some((character, length, start)) = fence {
                if character == marker.as_bytes()[0] && marker.len() >= length {
                    ranges.push(start..offset + line.len());
                    fence = None;
                }
            } else {
                fence = Some((marker.as_bytes()[0], marker.len(), offset));
            }
        }
        offset += line.len();
    }
    if let Some((_, _, start)) = fence {
        ranges.push(start..source.len());
    }
    let mut offset = 0;
    while offset < source.len() {
        if source.as_bytes()[offset] != b'`' || contains(&ranges, offset) {
            offset += 1;
            continue;
        }
        let length = source.as_bytes()[offset..]
            .iter()
            .take_while(|&&byte| byte == b'`')
            .count();
        let marker = "`".repeat(length);
        if let Some(end) = source[offset + length..].find(&marker) {
            let end = offset + length + end + length;
            ranges.push(offset..end);
            offset = end;
        } else {
            offset += 1;
        }
    }
    Ok(ranges)
}

pub fn extract(source: &str, chunks: &[Chunk]) -> Result<Vec<Fact>> {
    let context = Context {
        source,
        chunks,
        lines: LineIndex::new(source),
    };
    let code = code_ranges(source)?;
    let destinations = Destinations::new()?;
    let mut claimed = Vec::new();
    let mut definitions = HashMap::new();
    let mut facts = Vec::new();
    let mut emit = |value: String, imported: &str, start, end| {
        facts.push(context.import_range(
            value,
            imported,
            start,
            end,
            context.owner_range(start, end, |_| true),
        ));
    };
    let inline = Regex::new(
        r#"(!?)\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)"#,
    )?;
    for captures in inline.captures_iter(source) {
        let Some(whole) = captures.get(0) else {
            continue;
        };
        if contains(&code, whole.start()) {
            continue;
        }
        claimed.push(whole.range());
        let Some(raw) = captures.get(2).or_else(|| captures.get(3)) else {
            continue;
        };
        if let Some(value) = destinations.destination(raw.as_str()) {
            emit(
                value,
                if &captures[1] == "!" { "image" } else { "link" },
                raw.start(),
                raw.end(),
            );
        }
    }
    let definition = Regex::new(r"(?m)^ {0,3}\[([^\]\n]+)\]:\s*(?:<([^>\n]+)>|([^\s]+))")?;
    for captures in definition.captures_iter(source) {
        let Some(whole) = captures.get(0) else {
            continue;
        };
        if contains(&code, whole.start()) {
            continue;
        }
        claimed.push(whole.range());
        let Some(raw) = captures.get(2).or_else(|| captures.get(3)) else {
            continue;
        };
        let Some(value) = destinations.destination(raw.as_str()) else {
            continue;
        };
        let name = label(&captures[1]);
        if !name.is_empty() {
            definitions.entry(name).or_insert_with(|| value.clone());
        }
        emit(value, "reference", raw.start(), raw.end());
    }
    let full = Regex::new(r"(!?)\[([^\]\n]+)\]\[([^\]\n]*)\]")?;
    for captures in full.captures_iter(source) {
        let Some(whole) = captures.get(0) else {
            continue;
        };
        if contains(&code, whole.start()) || contains(&claimed, whole.start()) {
            continue;
        }
        claimed.push(whole.range());
        let name = label(if captures[3].is_empty() {
            &captures[2]
        } else {
            &captures[3]
        });
        if let Some(value) = definitions.get(&name) {
            emit(
                value.clone(),
                if &captures[1] == "!" { "image" } else { "link" },
                whole.start(),
                whole.end(),
            );
        }
    }
    let shortcut = Regex::new(r"(!?)\[([^\]\n]+)\]")?;
    for captures in shortcut.captures_iter(source) {
        let Some(whole) = captures.get(0) else {
            continue;
        };
        if matches!(source.as_bytes().get(whole.end()), Some(b'[' | b'('))
            || contains(&code, whole.start())
            || contains(&claimed, whole.start())
        {
            continue;
        }
        claimed.push(whole.range());
        if let Some(value) = definitions.get(&label(&captures[2])) {
            emit(
                value.clone(),
                if &captures[1] == "!" { "image" } else { "link" },
                whole.start(),
                whole.end(),
            );
        }
    }
    let autolink = Regex::new(r"<((?:https?)://[^ <>\n]+)>")?;
    for captures in autolink.captures_iter(source) {
        let Some(whole) = captures.get(0) else {
            continue;
        };
        if contains(&code, whole.start()) || contains(&claimed, whole.start()) {
            continue;
        }
        if let Some(raw) = captures.get(1) {
            emit(raw.as_str().into(), "link", raw.start(), raw.end());
        }
    }
    facts.sort_by_key(|fact| (fact.location.start_offset, fact.location.end_offset));
    Ok(facts)
}
