use super::{
    candidates::{self, Candidate},
    ranking::{self, Hit},
};
use crate::{
    analysis::Analysis,
    retrieval::{Evidence, split::Document},
};
use anyhow::{Context, Result, ensure};
use rusqlite::Connection;
use std::collections::HashMap;

mod references;

pub struct Response {
    pub source: Vec<FileResult>,
    pub docs: Vec<FileResult>,
    pub relations: Vec<references::Relation>,
}

pub struct FileResult {
    pub hit: Hit,
    pub preview: String,
    pub snapshot_hash: String,
    pub blocks: Vec<SourceBlock>,
}

pub struct SourceBlock {
    pub document: Candidate,
    pub part: usize,
    pub text: String,
    pub evidence: Vec<Evidence>,
}

pub fn search(
    db: &Connection,
    query: &str,
    vector: Option<&[f32]>,
    limit: usize,
    generated: &[String],
    policy: &str,
) -> Result<Response> {
    ensure!(
        (1..=100).contains(&limit),
        "limit must be between 1 and 100"
    );
    let candidates = candidates::read(db, query, vector)?.candidates;
    let signals = ranking::Signals::read(db, query, &candidates, generated)?;
    let hits = ranking::collapse_files(ranking::group_chunks(candidates, |hit| signals.apply(hit)));
    let mut snapshots = Snapshots {
        db,
        policy,
        files: HashMap::new(),
    };
    // ProjectSearchSession requests 100 before applying the caller's source limit.
    let (source, docs, mut relations) =
        references::segment(&mut snapshots, hits.into_iter().take(100).collect())?;
    let source = source
        .into_iter()
        .take(limit)
        .map(|hit| snapshots.result(hit))
        .collect::<Result<Vec<_>>>()?;
    let docs = docs
        .into_iter()
        .map(|hit| snapshots.result(hit))
        .collect::<Result<_>>()?;
    relations.retain(|r| {
        source
            .iter()
            .any(|s| s.hit.representative.path == r.source_path)
    });
    Ok(Response {
        source,
        docs,
        relations,
    })
}

struct Snapshot {
    analysis: Analysis,
    documents: Vec<Document>,
}

struct Snapshots<'a> {
    db: &'a Connection,
    policy: &'a str,
    files: HashMap<String, Snapshot>,
}

impl Snapshots<'_> {
    fn file(&mut self, path: &str) -> Result<&Snapshot> {
        if !self.files.contains_key(path) {
            let analysis =
                super::analysis::load(self.db, path)?.context("missing indexed source")?;
            let documents = super::documents::load_for_search(self.db, path, self.policy)?;
            self.files.insert(
                path.to_owned(),
                Snapshot {
                    analysis,
                    documents,
                },
            );
        }
        Ok(&self.files[path])
    }

    fn block(&mut self, candidate: &Candidate) -> Result<SourceBlock> {
        let file = self.file(&candidate.path)?;
        let doc = file
            .documents
            .get(candidate.ordinal)
            .context("missing indexed document")?;
        ensure!(
            doc.owner == candidate.owner && doc.source_chunk == candidate.source_chunk,
            "candidate owner mismatch"
        );
        Ok(SourceBlock {
            document: candidate.clone(),
            part: doc.part,
            text: doc.source_text(&file.analysis.source.text),
            evidence: doc.evidence.clone(),
        })
    }

    fn result(&mut self, hit: Hit) -> Result<FileResult> {
        let preview = preview(&self.block(&hit.representative)?.text, 96);
        let snapshot_hash = super::processing::source_hash(
            &self.file(&hit.representative.path)?.analysis.source.text,
        );
        let blocks = hit
            .windows
            .iter()
            .map(|c| self.block(c))
            .collect::<Result<_>>()?;
        Ok(FileResult {
            hit,
            preview,
            snapshot_hash,
            blocks,
        })
    }

    fn windows(&mut self, path: &str) -> Result<Vec<Candidate>> {
        let mut stmt=self.db.prepare("SELECT d.id, d.file_id, d.ordinal FROM retrieval_documents d JOIN files f ON f.id=d.file_id WHERE f.path=?1 ORDER BY d.ordinal")?;
        let rows = stmt
            .query_map([path], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let file = self.file(path)?;
        let mut windows = Vec::new();
        for (id, file_id, ordinal) in rows {
            let ordinal = usize::try_from(ordinal)?;
            let doc = file
                .documents
                .get(ordinal)
                .context("invalid document ordinal")?;
            windows.push(Candidate {
                source_chunk: doc.source_chunk,
                id,
                file_id,
                ordinal,
                owner: doc.owner,
                path: path.to_owned(),
                start: doc.evidence[0].span.start,
                end: doc.evidence.last().unwrap().span.end,
                semantic_score: None,
                lexical_score: None,
                semantic_rank: None,
                lexical_rank: None,
            });
        }
        windows.sort_by_key(|c| {
            (
                c.source_chunk
                    .map(|id| file.analysis.source_chunks[id].span.start)
                    .unwrap_or_else(|| {
                        c.owner
                            .map_or(0, |id| file.analysis.entities[id].span.start)
                    }),
                c.ordinal,
            )
        });
        Ok(windows)
    }
}

pub fn preview(text: &str, limit: usize) -> String {
    // ECMAScript whitespace, which differs from Rust at NEL and BOM.
    fn whitespace(c: char) -> bool {
        matches!(c,'\t'..='\r'|' '|'\u{a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}')
    }
    let collapsed = text
        .split(whitespace)
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if collapsed.chars().count() <= limit {
        return collapsed;
    }
    let prefix: String = collapsed.chars().take(limit.saturating_sub(1)).collect();
    format!("{}…", prefix.trim_end_matches(whitespace))
}

#[cfg(test)]
#[path = "../../tests/unit/storage/hybrid.rs"]
mod tests;
