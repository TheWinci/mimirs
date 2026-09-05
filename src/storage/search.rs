use anyhow::{Context, ensure};
use rusqlite::{Connection, params};

use crate::embedding;

#[derive(Debug)]
pub struct SearchResult {
    pub path: String,
    pub line_start: i64,
    pub line_end: i64,
    pub text: String,
    pub similarity: f64,
    pub indexed: Option<IndexedEvidence>,
}

#[derive(Debug)]
pub struct IndexedEvidence {
    pub owner: Option<usize>,
    pub snapshot_hash: String,
    pub spans: Vec<crate::retrieval::render::Evidence>,
}

pub fn has_content(connection: &Connection) -> anyhow::Result<bool> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM windows) OR EXISTS(SELECT 1 FROM retrieval_documents)",
            [],
            |row| row.get(0),
        )
        .context("cannot check indexed windows")
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
    if let (super::policy::Mode::Facts, Some(policy)) = super::policy::read(connection)? {
        return super::document_search::nearest(connection, query, limit, &policy);
    }
    nearest_raw(connection, query, limit)
}

pub(super) fn nearest_raw(
    connection: &Connection,
    query: &[f32],
    limit: usize,
) -> anyhow::Result<Vec<SearchResult>> {
    let retrieve = || -> anyhow::Result<Vec<SearchResult>> {
        let bytes: Vec<u8> = query.iter().flat_map(|value| value.to_ne_bytes()).collect();
        // vec0 chooses the top K. Sort those matches after retrieval because
        // its MATCH query only supports ORDER BY distance, without tie-breakers.
        let mut statement = connection.prepare(
            "SELECT f.path, c.line_start, c.line_end, w.text, 1.0 - e.distance
             FROM window_embeddings e
             JOIN windows w ON w.id = e.window_id
             JOIN chunks c ON c.id = w.chunk_id
             JOIN files f ON f.id = c.file_id
             WHERE e.embedding MATCH ?1 AND k = ?2
             ORDER BY e.distance",
        )?;
        let rows = statement.query_map(params![bytes, i64::try_from(limit)?], |row| {
            Ok(SearchResult {
                path: row.get(0)?,
                line_start: row.get(1)?,
                line_end: row.get(2)?,
                text: row.get(3)?,
                similarity: row.get(4)?,
                indexed: None,
            })
        })?;
        let mut results = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        ensure!(
            results.iter().all(|result| result.similarity.is_finite()),
            "retrieval returned a non-finite similarity"
        );
        results.sort_by(|left, right| {
            right
                .similarity
                .total_cmp(&left.similarity)
                .then_with(|| left.path.cmp(&right.path))
        });
        Ok(results)
    };
    retrieve().context("cannot retrieve nearest windows")
}
