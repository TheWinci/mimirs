use super::analysis::load;
use crate::source::SourceFile;
use anyhow::Result;
use rusqlite::Connection;
use sha2::{Digest, Sha256};

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

/// A matching snapshot is reusable only when its complete document set validates.
pub fn reusable(connection: &Connection, source: &SourceFile, policy: &str) -> Result<bool> {
    let tx = connection.unchecked_transaction()?;
    let Ok(Some(analysis)) = load(&tx, &source.path) else {
        return Ok(false);
    };
    if analysis.source != *source {
        return Ok(false);
    }
    Ok(super::documents::load(&tx, &source.path, policy).is_ok())
}
