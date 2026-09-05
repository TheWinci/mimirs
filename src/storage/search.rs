use anyhow::{Context, ensure};
use rusqlite::Connection;

use crate::embedding;

#[derive(Debug)]
pub struct SearchResult {
    pub path: String,
    pub line_start: i64,
    pub line_end: i64,
    pub text: String,
    pub similarity: f64,
    pub indexed: IndexedEvidence,
}

#[derive(Debug)]
pub struct IndexedEvidence {
    pub owner: Option<usize>,
    pub snapshot_hash: String,
    pub spans: Vec<crate::retrieval::Evidence>,
}

pub fn has_content(connection: &Connection) -> anyhow::Result<bool> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM retrieval_documents)",
            [],
            |row| row.get(0),
        )
        .context("cannot check indexed documents")
}

pub fn nearest(
    connection: &Connection,
    query: &[f32],
    limit: usize,
) -> anyhow::Result<Vec<SearchResult>> {
    ensure!(
        (1..=4096).contains(&limit),
        "limit must be between 1 and 4096"
    );
    ensure!(
        query.len() == embedding::DIMENSION,
        "invalid query vector dimension"
    );
    ensure!(
        query.iter().all(|value| value.is_finite()),
        "query vector contains a non-finite value"
    );
    if let Some(policy) = super::policy::read(connection)? {
        super::document_search::nearest(connection, query, limit, &policy)
    } else {
        Ok(Vec::new())
    }
}
