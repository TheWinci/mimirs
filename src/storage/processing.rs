use super::analysis::{ANALYSIS_VERSION, load};
use crate::source::SourceFile;
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use sha2::{Digest, Sha256};

const WINDOW_VERSION: &str = "whole-file/nonblank-lines-1";

pub fn source_hash(text: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    Sha256::digest(text.as_bytes())
        .iter()
        .flat_map(|byte| {
            [
                HEX[(byte >> 4) as usize] as char,
                HEX[(byte & 15) as usize] as char,
            ]
        })
        .collect()
}

pub(super) fn stamp(
    tx: &Transaction<'_>,
    id: i64,
    source: &SourceFile,
    rust: bool,
    chunks: usize,
    windows: usize,
) -> Result<()> {
    tx.execute("INSERT INTO file_processing VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(file_id) DO UPDATE SET source_hash=excluded.source_hash, extraction_version=excluded.extraction_version, window_version=excluded.window_version, chunk_count=excluded.chunk_count, window_count=excluded.window_count", params![id, source_hash(&source.text), rust.then_some(ANALYSIS_VERSION), WINDOW_VERSION, i64::try_from(chunks)?, i64::try_from(windows)?])?;
    Ok(())
}

pub fn reusable(
    connection: &Connection,
    source: &SourceFile,
    hash: &str,
    rust: bool,
) -> Result<bool> {
    let tx = connection.unchecked_transaction()?;
    let found = tx.query_row(
        "SELECT p.file_id FROM file_processing p JOIN files f ON f.id = p.file_id
         WHERE f.path = ?1 AND p.source_hash = ?2 AND p.extraction_version IS ?3 AND p.window_version = ?4
         AND p.chunk_count = (SELECT count(*) FROM chunks WHERE file_id = p.file_id)
         AND p.window_count = (SELECT count(*) FROM windows w JOIN chunks c ON c.id=w.chunk_id WHERE c.file_id=p.file_id)
         AND p.window_count = (SELECT count(*) FROM window_embeddings e JOIN windows w ON w.id=e.window_id JOIN chunks c ON c.id=w.chunk_id WHERE c.file_id=p.file_id)",
        params![source.path, hash, rust.then_some(ANALYSIS_VERSION), WINDOW_VERSION], |row| row.get::<_, i64>(0)
    ).optional()?;
    if found.is_none() {
        return Ok(false);
    }
    if rust {
        let Ok(Some(analysis)) = load(&tx, &source.path) else {
            return Ok(false);
        };
        if analysis.source != *source {
            return Ok(false);
        }
    }
    Ok(true)
}
