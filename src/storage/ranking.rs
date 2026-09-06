use super::candidates::{Candidate, fusion, locale_compare, ordinal_compare};
use anyhow::Result;
use regex::Regex;
use rusqlite::{Connection, params};
use std::{
    cmp::Ordering,
    collections::{BTreeMap, HashMap, HashSet},
    sync::LazyLock,
};

#[derive(Debug, Clone)]
pub struct Hit {
    pub representative: Candidate,
    pub score: f64,
    pub semantic_score: f64,
    pub lexical_score: f64,
    pub windows: Vec<Candidate>,
}

pub fn compare(left: &Hit, right: &Hit) -> Ordering {
    right
        .score
        .total_cmp(&left.score)
        .then_with(|| right.semantic_score.total_cmp(&left.semantic_score))
        .then_with(|| ordinal_compare(&left.representative.path, &right.representative.path))
        .then(left.representative.start.cmp(&right.representative.start))
        .then(left.representative.id.cmp(&right.representative.id))
}

pub fn compare_segmented(left: &Hit, right: &Hit) -> Ordering {
    right
        .score
        .total_cmp(&left.score)
        .then_with(|| right.semantic_score.total_cmp(&left.semantic_score))
        .then_with(|| locale_compare(&left.representative.path, &right.representative.path))
        .then(left.representative.start.cmp(&right.representative.start))
        .then(left.representative.id.cmp(&right.representative.id))
}

pub fn group_chunks(candidates: Vec<Candidate>, mut signals: impl FnMut(&mut Hit)) -> Vec<Hit> {
    let mut groups: BTreeMap<_, Vec<_>> = BTreeMap::new();
    for candidate in candidates {
        groups
            .entry((candidate.file_id, candidate.owner))
            .or_default()
            .push(candidate);
    }
    groups
        .into_values()
        .map(|mut group| {
            let semantic_rank = group.iter().filter_map(|c| c.semantic_rank).min();
            let lexical_rank = group.iter().filter_map(|c| c.lexical_rank).min();
            group.sort_by(|a, b| {
                b.score()
                    .total_cmp(&a.score())
                    .then_with(|| {
                        b.semantic_score
                            .unwrap_or(0.0)
                            .total_cmp(&a.semantic_score.unwrap_or(0.0))
                    })
                    .then_with(|| a.compare_position(b))
            });
            let mut hit = Hit {
                representative: group[0].clone(),
                score: fusion(semantic_rank, lexical_rank),
                semantic_score: group
                    .iter()
                    .map(|c| c.semantic_score.unwrap_or(0.0))
                    .reduce(f64::max)
                    .unwrap(),
                lexical_score: group
                    .iter()
                    .map(|c| c.lexical_score.unwrap_or(0.0))
                    .reduce(f64::max)
                    .unwrap(),
                windows: group,
            };
            order_windows(&mut hit.windows);
            signals(&mut hit);
            hit
        })
        .collect()
}

pub fn collapse_files(hits: Vec<Hit>) -> Vec<Hit> {
    let mut files: BTreeMap<_, Vec<_>> = BTreeMap::new();
    for hit in hits {
        files
            .entry(hit.representative.path.clone())
            .or_default()
            .push(hit);
    }
    let mut result: Vec<_> = files
        .into_values()
        .map(|mut hits| {
            hits.sort_by(compare);
            let mut best = hits[0].clone();
            if let Some(second) = hits.get(1) {
                best.score += 0.25 * best.score.min(second.score);
            }
            best.windows = hits.into_iter().flat_map(|h| h.windows).collect();
            order_windows(&mut best.windows);
            best
        })
        .collect();
    result.sort_by(compare);
    result
}

pub fn merge(left: Hit, right: Hit) -> Hit {
    let mut best = if compare_segmented(&left, &right).is_le() {
        left.clone()
    } else {
        right.clone()
    };
    best.windows = left.windows.into_iter().chain(right.windows).collect();
    order_windows(&mut best.windows);
    best
}

fn order_windows(windows: &mut Vec<Candidate>) {
    windows.sort_by_key(|c| (c.start, c.end, c.id));
    windows.dedup_by_key(|c| c.id);
}

static IDENTIFIER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?-u:\b)[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)?(?-u:\b)").unwrap()
});
const STOP_WORDS: &str = "the and for from with that this what when where how all not but has have get set new use can will should into each only does file files code function method class type return error value data name path index query result results search find create update delete remove add list check test run build";

pub fn identifiers(query: &str, definitions: bool) -> Vec<String> {
    let mut seen = HashSet::new();
    IDENTIFIER
        .find_iter(query)
        .map(|m| m.as_str())
        .filter(|s| {
            s.len() >= 3
                && !STOP_WORDS
                    .split_whitespace()
                    .any(|word| word == s.to_lowercase())
                && (s.bytes().any(|b| b.is_ascii_uppercase()) || s.contains(['_', '.']))
                && (!definitions
                    || !(s.as_bytes()[0].is_ascii_uppercase()
                        && s.bytes()
                            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')))
                && seen.insert(*s)
        })
        .map(str::to_owned)
        .collect()
}

static TEST_PATH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:^|[/\\])(?:tests?|__tests__|spec)[/\\]|\.(?:test|spec)\.[^/\\]+$|(?:^|[/\\])test_[^/\\]*$").unwrap()
});
pub fn is_test(path: &str) -> bool {
    TEST_PATH.is_match(path)
}

pub struct Signals {
    names: HashMap<(i64, Option<usize>), String>,
    unique: HashSet<(i64, Option<usize>)>,
    query_terms: Vec<String>,
    generated: globset::GlobSet,
}

impl Signals {
    pub fn read(
        db: &Connection,
        query: &str,
        candidates: &[Candidate],
        generated: &[String],
    ) -> Result<Self> {
        let mut names = HashMap::new();
        let mut stmt = db.prepare("SELECT name FROM entities WHERE file_id=?1 AND ordinal=?2")?;
        for candidate in candidates {
            let key = (candidate.file_id, candidate.owner);
            if let Some(owner) = candidate.owner
                && !names.contains_key(&key)
            {
                use rusqlite::OptionalExtension;
                if let Some(name) = stmt
                    .query_row(params![candidate.file_id, owner as i64], |r| {
                        r.get::<_, Option<String>>(0)
                    })
                    .optional()?
                    .flatten()
                {
                    names.insert(key, name);
                }
            }
        }
        let mut stmt = db.prepare("SELECT e.file_id, e.ordinal, lower(e.name), f.path FROM entities e
            JOIN files f ON f.id=e.file_id WHERE e.name COLLATE NOCASE IN (SELECT value FROM json_each(?1))")?;
        let rows = stmt
            .query_map([serde_json::to_string(&identifiers(query, true))?], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut paths: HashMap<&str, HashSet<&str>> = HashMap::new();
        for (_, _, name, path) in &rows {
            paths.entry(name).or_default().insert(path);
        }
        let unique = rows
            .iter()
            .filter(|(_, _, name, _)| paths[name.as_str()].len() == 1)
            .map(|(file, owner, _, _)| (*file, Some(*owner as usize)))
            .collect();
        let mut globs = globset::GlobSetBuilder::new();
        for pattern in generated {
            let pattern = normalized_path(pattern);
            for pattern in [pattern.clone(), format!("**/{pattern}")] {
                globs.add(
                    globset::GlobBuilder::new(&pattern)
                        .literal_separator(true)
                        .backslash_escape(false)
                        .build()?,
                );
            }
        }
        Ok(Self {
            names,
            unique,
            query_terms: super::lexical::terms(query),
            generated: globs.build()?,
        })
    }

    pub fn apply(&self, hit: &mut Hit) {
        let key = (hit.representative.file_id, hit.representative.owner);
        if let Some(name) = self.names.get(&key) {
            let terms = super::lexical::terms(name);
            if !terms.is_empty() && terms.iter().all(|t| self.query_terms.contains(t)) {
                hit.score *= 1.2;
            }
        }
        if self.unique.contains(&key) {
            hit.score *= 1.3;
        }
        if is_test(&hit.representative.path) {
            hit.score *= 0.85;
        }
        if self
            .generated
            .is_match(normalized_path(&hit.representative.path))
        {
            hit.score *= 0.75;
        }
    }
}

pub(super) fn normalized_path(path: &str) -> String {
    let path = path.replace('\\', "/");
    path.strip_prefix("./").unwrap_or(&path).to_owned()
}

#[cfg(test)]
#[path = "../../tests/unit/storage/ranking.rs"]
mod tests;
