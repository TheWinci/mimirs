//! Concrete filesystem operations shared below the domains.
use anyhow::{Result, ensure};
use sha2::{Digest, Sha256};
use std::path::{Component, Path};
pub(crate) mod cache;
pub fn fingerprint(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub fn validate_path(path: &str) -> Result<()> {
    ensure!(
        !path.is_empty() && !path.contains('\\') && !path.contains('\0'),
        "evidence path must be a relative repository path"
    );
    ensure!(
        Path::new(path)
            .components()
            .all(|p| matches!(p, Component::Normal(_)))
            && !path
                .split('/')
                .any(|p| p.is_empty() || p == "." || p == ".." || p == ".git"),
        "evidence path must be normalized and inside the repository"
    );
    Ok(())
}
pub(crate) fn preview(text: &str, max: usize) -> &str {
    let mut end = text.len().min(max);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Stamp {
    len: u64,
    modified: Option<u128>,
}
pub fn stamp(path: &Path) -> Result<Stamp> {
    let metadata = std::fs::metadata(path)?;
    Ok(Stamp {
        len: metadata.len(),
        modified: metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_nanos()),
    })
}
