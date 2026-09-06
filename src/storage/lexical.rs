use std::{collections::HashSet, sync::LazyLock};

use anyhow::{Result, ensure};
use regex::Regex;
use rusqlite::{Connection, params};
use unicode_normalization::UnicodeNormalization;

static CAMEL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"([\p{Ll}\p{N}])([\p{Lu}])").unwrap());
static ACRONYM: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"([\p{Lu}]+)([\p{Lu}][\p{Ll}])").unwrap());
static TERMS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\p{L}\p{N}]+").unwrap());

/// TS v2 applies these transformations before SQLite's unicode61 tokenizer.
pub fn terms(text: &str) -> Vec<String> {
    let normalized: String = text.nfkc().collect();
    let camel = CAMEL.replace_all(&normalized, "$1 $2");
    let split = ACRONYM.replace_all(&camel, "$1 $2").to_lowercase();
    TERMS
        .find_iter(&split)
        .map(|m| m.as_str())
        // JavaScript measures string length in UTF-16, including here.
        .filter(|s| s.encode_utf16().count() > 1 || s.bytes().all(|b| b.is_ascii_digit()))
        .map(str::to_owned)
        .collect()
}

pub fn query(text: &str) -> Option<String> {
    let mut seen = HashSet::new();
    let terms: Vec<_> = terms(text)
        .into_iter()
        .filter(|t| seen.insert(t.clone()))
        .map(|t| format!("\"{t}\""))
        .collect();
    (!terms.is_empty()).then(|| terms.join(" OR "))
}

pub(super) fn insert(
    db: &Connection,
    id: i64,
    path: &str,
    name: Option<&str>,
    source: &str,
) -> Result<()> {
    db.execute(
        "INSERT INTO document_fts(rowid, path, chunk_name, text) VALUES (?1, ?2, ?3, ?4)",
        params![
            id,
            terms(path).join(" "),
            terms(name.unwrap_or_default()).join(" "),
            terms(source).join(" ")
        ],
    )?;
    Ok(())
}

#[derive(Debug)]
pub struct Hit {
    pub id: i64,
    pub score: f64,
}

/// Native BM25 uses field weights, not duplicated terms in document lengths.
pub fn candidates(db: &Connection, text: &str, limit: usize) -> Result<Vec<Hit>> {
    ensure!(
        limit > 0 && limit <= i64::MAX as usize,
        "invalid lexical candidate limit"
    );
    let Some(query) = query(text) else {
        return Ok(Vec::new());
    };
    let mut stmt = db.prepare(
        "SELECT d.id, -bm25(document_fts, 2.0, 3.0, 1.0)
        FROM document_fts JOIN retrieval_documents d ON d.id=document_fts.rowid
        JOIN files f ON f.id=d.file_id
        WHERE document_fts MATCH ?1
        ORDER BY bm25(document_fts, 2.0, 3.0, 1.0), f.path,
            json_extract(d.evidence, '$[0].span.start'), d.id LIMIT ?2",
    )?;
    Ok(stmt
        .query_map(params![query, limit as i64], |r| {
            Ok(Hit {
                id: r.get(0)?,
                score: r.get(1)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?)
}

#[cfg(test)]
#[path = "../../tests/unit/storage/lexical.rs"]
mod tests;
