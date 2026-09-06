//! TS v2's bounded candidate union. Completion can enlarge either channel, but
//! never introduces a document outside the initial lexical/semantic union.
use std::{cmp::Ordering, collections::BTreeMap, sync::LazyLock};

use anyhow::{Context, Result, ensure};
use icu_collator::{Collator, CollatorBorrowed};
use rusqlite::{Connection, OptionalExtension, params};

use super::lexical;

pub const LEXICAL_LIMIT: usize = 100;
pub const SEMANTIC_LIMIT: usize = 150;

// The frozen Bun reference uses English locale collation for channel ties.
// Final hit ties use JavaScript's UTF-16 ordinal ordering instead.
static COLLATOR: LazyLock<CollatorBorrowed<'static>> = LazyLock::new(|| {
    Collator::try_new(Default::default(), Default::default()).expect("compiled root collation")
});

pub fn locale_compare(left: &str, right: &str) -> Ordering {
    COLLATOR.compare(left, right)
}

pub fn ordinal_compare(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

#[derive(Clone, Debug)]
pub struct Candidate {
    pub id: i64,
    pub file_id: i64,
    pub ordinal: usize,
    pub owner: Option<usize>,
    pub path: String,
    pub start: usize,
    pub semantic_score: Option<f64>,
    pub lexical_score: Option<f64>,
    pub semantic_rank: Option<usize>,
    pub lexical_rank: Option<usize>,
}

impl Candidate {
    pub fn score(&self) -> f64 {
        fusion(self.semantic_rank, self.lexical_rank)
    }

    pub fn compare_position(&self, other: &Self) -> Ordering {
        locale_compare(&self.path, &other.path)
            .then(self.start.cmp(&other.start))
            .then(self.id.cmp(&other.id))
    }
}

pub fn fusion(semantic: Option<usize>, lexical: Option<usize>) -> f64 {
    (semantic.map_or(0.0, |rank| 0.6 / (60.0 + rank as f64))
        + lexical.map_or(0.0, |rank| 0.4 / (60.0 + rank as f64)))
        * 61.0
}

pub struct Read {
    pub candidates: Vec<Candidate>,
    pub baseline_semantic: Vec<i64>,
    pub baseline_lexical: Vec<i64>,
}

pub fn read(db: &Connection, query: &str, vector: Option<&[f32]>) -> Result<Read> {
    read_with_limits(db, query, vector, LEXICAL_LIMIT, SEMANTIC_LIMIT, true)
}

fn read_with_limits(
    db: &Connection,
    query: &str,
    vector: Option<&[f32]>,
    lexical_limit: usize,
    semantic_limit: usize,
    complete: bool,
) -> Result<Read> {
    ensure!(
        (1..=4096).contains(&semantic_limit),
        "invalid semantic candidate limit"
    );
    if let Some(vector) = vector {
        ensure!(
            vector.len() == crate::embedding::DIMENSION,
            "invalid query vector dimension"
        );
        ensure!(
            vector.iter().all(|v| v.is_finite()),
            "non-finite query vector"
        );
        ensure!(vector.iter().any(|v| *v != 0.0), "zero query vector");
    }
    let mut semantic = BTreeMap::new();
    if let Some(vector) = vector {
        let mut stmt = db.prepare("SELECT document_id, distance FROM document_embeddings WHERE embedding MATCH ?1 AND k=?2")?;
        for row in stmt.query_map(
            params![super::vector_bytes(vector), semantic_limit as i64],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Option<f64>>(1)?)),
        )? {
            let (id, distance) = row?;
            if let Some(score) = distance.map(|d| 1.0 - d).filter(|s| s.is_finite()) {
                semantic.insert(id, score);
            }
        }
    }
    let initial_lexical = lexical::candidates(db, query, lexical_limit)?;
    let mut lexical: BTreeMap<_, _> = initial_lexical.iter().map(|h| (h.id, h.score)).collect();
    let ids: std::collections::BTreeSet<_> =
        semantic.keys().chain(lexical.keys()).copied().collect();
    let mut candidates = Vec::new();
    let mut stmt = db.prepare(
        "SELECT d.file_id, d.ordinal, d.owner, f.path,
        json_extract(d.evidence, '$[0].span.start') FROM retrieval_documents d
        JOIN files f ON f.id=d.file_id WHERE d.id=?1",
    )?;
    for id in ids {
        let candidate = stmt
            .query_row([id], |r| {
                Ok(Candidate {
                    id,
                    file_id: r.get(0)?,
                    ordinal: position(r, 1)?,
                    owner: r
                        .get::<_, Option<i64>>(2)?
                        .map(|v| {
                            usize::try_from(v)
                                .map_err(|_| rusqlite::Error::IntegralValueOutOfRange(2, v))
                        })
                        .transpose()?,
                    path: r.get(3)?,
                    start: position(r, 4)?,
                    semantic_score: semantic.get(&id).copied(),
                    lexical_score: lexical.get(&id).copied(),
                    semantic_rank: None,
                    lexical_rank: None,
                })
            })
            .with_context(|| format!("missing candidate document {id}"))?;
        candidates.push(candidate);
    }
    let baseline_semantic = channel_order(&candidates, true);
    let baseline_lexical: Vec<_> = initial_lexical.iter().map(|h| h.id).collect();
    if complete && let Some(vector) = vector {
        let mut stmt =
            db.prepare("SELECT embedding FROM document_embeddings WHERE document_id=?1")?;
        for candidate in &candidates {
            if semantic.contains_key(&candidate.id) {
                continue;
            }
            let bytes: Option<Vec<u8>> = stmt.query_row([candidate.id], |r| r.get(0)).optional()?;
            if let Some(bytes) = bytes {
                ensure!(
                    bytes.len() == vector.len() * 4,
                    "invalid stored vector dimension"
                );
                let stored: Vec<_> = bytes
                    .chunks_exact(4)
                    .map(|b| f32::from_ne_bytes(b.try_into().unwrap()))
                    .collect();
                if let Some(score) = cosine(vector, &stored) {
                    semantic.insert(candidate.id, score);
                }
            }
        }
        if let Some(query) = lexical::query(query) {
            let missing: Vec<_> = semantic
                .keys()
                .filter(|id| !lexical.contains_key(id))
                .copied()
                .collect();
            let mut stmt = db.prepare(
                "SELECT rowid, -bm25(document_fts, 2.0, 3.0, 1.0) FROM document_fts
                WHERE document_fts MATCH ?1 AND rowid IN (SELECT value FROM json_each(?2))",
            )?;
            for row in stmt.query_map(params![query, serde_json::to_string(&missing)?], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, f64>(1)?))
            })? {
                let (id, score) = row?;
                if score.is_finite() {
                    lexical.insert(id, score);
                }
            }
        }
    }
    for candidate in &mut candidates {
        candidate.semantic_score = semantic.get(&candidate.id).copied();
        candidate.lexical_score = lexical.get(&candidate.id).copied();
    }
    for semantic in [true, false] {
        let order = if !semantic && (!complete || vector.is_none()) {
            baseline_lexical.clone()
        } else {
            channel_order(&candidates, semantic)
        };
        let ranks: BTreeMap<_, _> = order
            .into_iter()
            .enumerate()
            .map(|(i, id)| (id, i + 1))
            .collect();
        for candidate in &mut candidates {
            let rank = ranks.get(&candidate.id).copied();
            if semantic {
                candidate.semantic_rank = rank;
            } else {
                candidate.lexical_rank = rank;
            }
        }
    }
    Ok(Read {
        candidates,
        baseline_semantic,
        baseline_lexical,
    })
}

fn channel_order(candidates: &[Candidate], semantic: bool) -> Vec<i64> {
    let score = |c: &Candidate| {
        if semantic {
            c.semantic_score
        } else {
            c.lexical_score
        }
    };
    let mut channel: Vec<_> = candidates.iter().filter(|c| score(c).is_some()).collect();
    channel.sort_by(|a, b| {
        score(b)
            .unwrap()
            .total_cmp(&score(a).unwrap())
            .then_with(|| a.compare_position(b))
    });
    channel.into_iter().map(|c| c.id).collect()
}

fn cosine(left: &[f32], right: &[f32]) -> Option<f64> {
    let (mut dot, mut left_sq, mut right_sq) = (0.0, 0.0, 0.0);
    for (&left, &right) in left.iter().zip(right) {
        let (left, right) = (left as f64, right as f64);
        dot += left * right;
        left_sq += left * left;
        right_sq += right * right;
    }
    let score = dot / (left_sq * right_sq).sqrt();
    score.is_finite().then_some(score)
}

#[cfg(test)]
#[path = "../../tests/unit/storage/candidates.rs"]
mod tests;

fn position(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<usize> {
    let value: i64 = row.get(index)?;
    usize::try_from(value).map_err(|_| rusqlite::Error::IntegralValueOutOfRange(index, value))
}
