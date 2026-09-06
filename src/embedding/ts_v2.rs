//! TS v2 MiniLM input construction and float32 averaging. Model execution stays
//! in the existing bounded worker pool.
use anyhow::{Result, ensure};
use regex::Regex;
use std::sync::LazyLock;
use tokenizers::{Model, NormalizedString, Normalizer, Tokenizer};

pub const LIMIT: usize = 256;
const OVERLAP: usize = 32;
static PIECE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
    r"[^\x09-\x0d \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}",
    r"\p{P}\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]+|[\p{P}\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]"
)).unwrap()
});

pub fn unbounded(mut tokenizer: Tokenizer) -> Result<Tokenizer> {
    tokenizer
        .with_truncation(None)
        .map_err(|e| anyhow::anyhow!(e))?;
    tokenizer.with_padding(None);
    Ok(tokenizer)
}

pub fn ids(tokenizer: &Tokenizer, text: &str) -> Result<Vec<u32>> {
    Ok(tokenizer
        .encode(text, true)
        .map_err(|e| anyhow::anyhow!(e))?
        .get_ids()
        .to_vec())
}

pub fn document_inputs(tokenizer: &Tokenizer, projected: &str) -> Result<Vec<String>> {
    let newline = projected.find('\n');
    ensure!(
        projected.starts_with("File: ") && newline.is_some_and(|n| n > 6),
        "path-average input must start with File: <relative path> and a newline"
    );
    let newline = newline.unwrap();
    let (prefix, text) = projected.split_at(newline + 1);
    if ids(tokenizer, projected)?.len() <= LIMIT {
        return Ok(vec![projected.into()]);
    }
    let mut pieces = Vec::new();
    for m in PIECE.find_iter(text) {
        let mut normalized = NormalizedString::from(m.as_str());
        if let Some(normalizer) = tokenizer.get_normalizer() {
            normalizer
                .normalize(&mut normalized)
                .map_err(|e| anyhow::anyhow!(e))?;
        }
        let tokens = tokenizer
            .get_model()
            .tokenize(normalized.get())
            .map_err(|e| anyhow::anyhow!(e))?
            .len()
            .max(1);
        pieces.push((m.start(), tokens));
    }
    ensure!(
        !pieces.is_empty(),
        "cannot split oversized path-average input"
    );
    let mut windows = Vec::new();
    let mut start_piece = 0;
    let prefix_tokens = ids(tokenizer, prefix)?.len();
    while start_piece < pieces.len() {
        let mut end_piece = start_piece;
        let mut tokens = prefix_tokens;
        while end_piece < pieces.len() && tokens + pieces[end_piece].1 <= LIMIT {
            tokens += pieces[end_piece].1;
            end_piece += 1;
        }
        if end_piece == start_piece {
            end_piece += 1;
        }
        let start = if start_piece == 0 {
            0
        } else {
            pieces[start_piece].0
        };
        let mut end = pieces.get(end_piece).map_or(text.len(), |p| p.0);
        while end_piece > start_piece + 1
            && ids(tokenizer, &format!("{prefix}{}", &text[start..end]))?.len() > LIMIT
        {
            end_piece -= 1;
            end = pieces[end_piece].0;
        }
        let window = format!("{prefix}{}", &text[start..end]);
        ensure!(
            ids(tokenizer, &window)?.len() <= LIMIT,
            "cannot fit source piece within 256 tokens"
        );
        windows.push(window);
        if end_piece == pieces.len() {
            break;
        }
        let mut next = end_piece;
        let mut overlap = 0;
        while next > start_piece && overlap < OVERLAP {
            next -= 1;
            overlap += pieces[next].1;
        }
        start_piece = if next > start_piece { next } else { end_piece };
    }
    Ok(windows)
}

pub fn query_inputs(tokenizer: &Tokenizer, text: &str) -> Result<Vec<(String, usize)>> {
    let ids = ids(tokenizer, text)?;
    if ids.len() <= LIMIT {
        return Ok(vec![(text.into(), ids.len())]);
    }
    let mut windows = Vec::new();
    let mut start = 0;
    while start < ids.len() {
        let end = (start + LIMIT).min(ids.len());
        let decoded = tokenizer
            .decode(&ids[start..end], true)
            .map_err(|e| anyhow::anyhow!(e))?;
        windows.push((decoded, end - start));
        if end == ids.len() {
            break;
        }
        start = end - OVERLAP;
    }
    Ok(windows)
}

pub fn merge(vectors: &[&[f32]]) -> Result<Vec<f32>> {
    ensure!(!vectors.is_empty(), "cannot merge zero embeddings");
    if vectors.len() == 1 {
        return Ok(vectors[0].to_vec());
    }
    let mut merged = vec![0.0_f32; super::DIMENSION];
    for vector in vectors {
        ensure!(
            vector.len() == merged.len(),
            "invalid merge vector dimensions"
        );
        for (sum, value) in merged.iter_mut().zip(*vector) {
            *sum += *value;
        }
    }
    let mut norm = 0.0_f64;
    for value in &mut merged {
        // TS divides in float64 and stores into Float32Array after each step.
        *value = (*value as f64 / vectors.len() as f64) as f32;
        norm += (*value as f64) * (*value as f64);
    }
    let norm = norm.sqrt();
    ensure!(norm.is_finite(), "non-finite merged embedding");
    if norm > 0.0 {
        for value in &mut merged {
            *value = (*value as f64 / norm) as f32;
        }
    }
    Ok(merged)
}

#[cfg(test)]
#[path = "../../tests/unit/embedding/ts_v2.rs"]
mod tests;
