//! Retrieval uses TS v2's normalized text while citations use the raw snapshot.
//! Store offset changes only; ASCII/LF files need no per-character map.
use anyhow::{Result, ensure};

pub struct Source {
    pub text: String,
    raw_changes: Vec<(usize, usize)>,
    utf16_changes: Vec<(usize, usize)>,
}

impl Source {
    pub fn new(raw: &str) -> Self {
        let start = usize::from(raw.starts_with('\u{feff}')) * 3;
        let mut text = String::with_capacity(raw.len() - start);
        let mut raw_changes = vec![(0, start)];
        let mut utf16_changes = vec![(0, 0)];
        let mut chars = raw[start..].char_indices().peekable();
        let mut units = 0;
        while let Some((offset, c)) = chars.next() {
            let mut raw_end = start + offset + c.len_utf8();
            let normalized = if c == '\r' {
                if chars.peek().is_some_and(|(_, c)| *c == '\n') {
                    chars.next();
                    raw_end += 1;
                }
                '\n'
            } else {
                c
            };
            text.push(normalized);
            units += normalized.len_utf16();
            if normalized.len_utf8() != normalized.len_utf16() {
                utf16_changes.push((text.len(), units));
            }
            let &(before, after) = raw_changes.last().unwrap();
            if raw_end - text.len() != after - before {
                raw_changes.push((text.len(), raw_end));
            }
        }
        Self {
            text,
            raw_changes,
            utf16_changes,
        }
    }

    pub fn raw_offset(&self, byte: usize) -> Result<usize> {
        ensure!(
            self.text.is_char_boundary(byte),
            "invalid normalized UTF-8 boundary"
        );
        let index = self
            .raw_changes
            .partition_point(|(before, _)| *before <= byte)
            - 1;
        let (before, after) = self.raw_changes[index];
        Ok(byte - before + after)
    }

    pub fn normalized_offset(&self, raw: usize) -> Result<usize> {
        let index = self
            .raw_changes
            .partition_point(|(_, after)| *after <= raw)
            .saturating_sub(1);
        let (before, after) = self.raw_changes[index];
        let byte = raw.saturating_sub(after) + before;
        ensure!(
            self.text.is_char_boundary(byte),
            "invalid raw retrieval boundary"
        );
        ensure!(
            self.raw_offset(byte)? == raw,
            "raw boundary lies inside normalized source bytes"
        );
        Ok(byte)
    }

    pub fn utf16_offset(&self, byte: usize) -> Result<usize> {
        ensure!(
            self.text.is_char_boundary(byte),
            "invalid normalized UTF-8 boundary"
        );
        let index = self
            .utf16_changes
            .partition_point(|(before, _)| *before <= byte)
            - 1;
        let (before, after) = self.utf16_changes[index];
        Ok(byte - before + after)
    }

    #[cfg(test)]
    pub fn byte_offset(&self, units: usize) -> Result<usize> {
        let index = self
            .utf16_changes
            .partition_point(|(_, after)| *after <= units)
            - 1;
        let (before, after) = self.utf16_changes[index];
        let byte = units - after + before;
        ensure!(
            self.text.is_char_boundary(byte),
            "invalid normalized UTF-16 boundary"
        );
        Ok(byte)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalized_utf16_spans_map_to_exact_raw_bytes() {
        let raw = "\u{feff}café 🧭\r\nnext\rend\n";
        let source = Source::new(raw);
        assert_eq!(source.text, "café 🧭\nnext\nend\n");
        for byte in source
            .text
            .char_indices()
            .map(|(i, _)| i)
            .chain(std::iter::once(source.text.len()))
        {
            let units = source.text[..byte].encode_utf16().count();
            assert_eq!(source.utf16_offset(byte).unwrap(), units);
            assert_eq!(source.byte_offset(units).unwrap(), byte);
            let raw_byte = source.raw_offset(byte).unwrap();
            assert!(raw.is_char_boundary(raw_byte));
            assert_eq!(source.normalized_offset(raw_byte).unwrap(), byte);
        }
        assert!(source.byte_offset(6).is_err());
        assert_eq!(
            &raw[source.raw_offset(11).unwrap()..source.raw_offset(16).unwrap()],
            "next\r"
        );
    }
}
