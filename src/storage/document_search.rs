use super::search::{IndexedEvidence, SearchResult};
use anyhow::{Context, Result, ensure};
use rusqlite::{Connection, params};
use std::collections::HashMap;

// vec0 supports at most 4096 nearest candidates per query in this policy.
const CANDIDATE_LIMIT: usize = 4096;

pub fn nearest(
    connection: &Connection,
    query: &[f32],
    limit: usize,
    policy: &str,
) -> Result<Vec<SearchResult>> {
    let bytes: Vec<u8> = query.iter().flat_map(|v| v.to_ne_bytes()).collect();
    let mut k = limit.saturating_mul(4).clamp(16, CANDIDATE_LIMIT);
    loop {
        let mut statement = connection.prepare("SELECT f.path, d.ordinal, 1.0-e.distance FROM document_embeddings e JOIN retrieval_documents d ON d.id=e.document_id JOIN files f ON f.id=d.file_id WHERE e.embedding MATCH ?1 AND k=?2 ORDER BY e.distance")?;
        let candidates = statement
            .query_map(params![bytes, k as i64], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, f64>(2)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let document_count = candidates.len();
        let document_frontier = candidates.last().map(|(_, _, score)| *score);
        let mut snapshots = HashMap::new();
        let mut results: Vec<SearchResult> = Vec::new();
        let mut positions = HashMap::new();
        for (path, ordinal, similarity) in candidates {
            ensure!(similarity.is_finite(), "non-finite document similarity");
            if !snapshots.contains_key(&path) {
                let analysis = super::analysis::load(connection, &path)?
                    .context("missing indexed snapshot")?;
                let documents = super::documents::load(connection, &path, policy)?;
                snapshots.insert(path.clone(), (analysis, documents));
            }
            let (analysis, documents) = &snapshots[&path];
            let document = documents
                .get(usize::try_from(ordinal)?)
                .context("invalid candidate document ordinal")?;
            let key = (path.clone(), document.owner);
            if let Some(&position) = positions.get(&key) {
                let hit: &mut SearchResult = &mut results[position];
                let evidence = &mut hit
                    .indexed
                    .as_mut()
                    .context("missing indexed evidence")?
                    .spans;
                for span in &document.evidence {
                    if !evidence.contains(span) {
                        evidence.push(span.clone());
                    }
                }
                continue;
            }
            let span = document
                .owner
                .map_or(&analysis.scopes[0].span, |id| &analysis.entities[id].span);
            positions.insert(key, results.len());
            let mut spans = Vec::new();
            for evidence in &document.evidence {
                if !spans.contains(evidence) {
                    spans.push(evidence.clone());
                }
            }
            results.push(SearchResult {
                path,
                line_start: span.line_start as i64,
                line_end: span.line_end as i64,
                text: document.text.clone(),
                similarity,
                indexed: Some(IndexedEvidence {
                    owner: document.owner,
                    snapshot_hash: super::processing::source_hash(&analysis.source.text),
                    spans,
                }),
            });
        }
        let raw = super::search::nearest_raw(connection, query, k)?;
        let raw_count = raw.len();
        let raw_frontier = raw.last().map(|hit| hit.similarity);
        let mut files = std::collections::HashSet::new();
        for hit in raw {
            if files.insert(hit.path.clone()) {
                results.push(hit);
            }
        }
        results.sort_by(|a, b| {
            b.similarity
                .total_cmp(&a.similarity)
                .then_with(|| a.path.cmp(&b.path))
                .then_with(|| a.line_start.cmp(&b.line_start))
        });
        let threshold = results.get(limit - 1).map(|hit| hit.similarity);
        let complete = threshold.is_some_and(|score| {
            (document_count < k || document_frontier.is_none_or(|frontier| score >= frontier))
                && (raw_count < k || raw_frontier.is_none_or(|frontier| score >= frontier))
        });
        if complete || k == CANDIDATE_LIMIT || (document_count < k && raw_count < k) {
            results.truncate(limit);
            return Ok(results);
        }
        k = (k * 2).min(CANDIDATE_LIMIT);
    }
}
