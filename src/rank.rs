use std::collections::HashMap;
use std::path::Path;

use crate::store::Hit;

/// Share of the fused score that comes from the vector list; the keyword list
/// gives the rest.
const VECTOR_WEIGHT: f32 = 0.5;
/// The vector weight the S5 probe tries (TS v2's choice after score completion).
pub const PROBE_VECTOR_WEIGHT: f32 = 0.6;
/// The share of a file's second-best chunk the S8 probe adds (TS v2's value
/// with score completion).
pub const PROBE_SECOND_CHUNK_WEIGHT: f32 = 0.25;
/// The smaller share a follow-up run tries (TS v2's best without completion).
pub const PROBE_SMALL_SECOND_CHUNK_WEIGHT: f32 = 0.10;
/// The factor the S9 probe gives chunks in test files (TS v2's value).
pub const PROBE_TEST_MULTIPLIER: f32 = 0.85;
/// Folders that hold tests.
const TEST_FOLDERS: [&str; 4] = ["test", "tests", "__tests__", "spec"];
/// Reciprocal-rank constant: rank 0 counts 1, rank 60 counts half.
const RANK_CONSTANT: f32 = 60.0;
/// Extensions of documentation files (TS v2's list); `.txt` covers Django's docs.
const DOC_EXTENSIONS: [&str; 6] = ["md", "mdx", "markdown", "rst", "txt", "adoc"];

/// A file in the answer and the chunks that matched in it.
pub struct RankedFile {
    pub path: String,
    /// The fused score of the file's best chunk.
    pub score: f32,
    /// The file's matching chunks, best first.
    pub chunk_ids: Vec<i64>,
}

/// How chunk scores turn into file ranks; the ranking plan's probes change it.
pub struct Signals {
    /// Share of the fused score that comes from the vector list.
    pub vector_weight: f32,
    /// Factors for fused chunk scores, by chunk ID, applied before chunks
    /// are grouped into files; chunks not listed keep their score.
    pub chunk_multipliers: HashMap<i64, f32>,
    /// Share of a file's second-best chunk score added to its best; 0 adds
    /// nothing.
    pub second_chunk_weight: f32,
    /// Factor for chunks in test files; 1 leaves them as they are.
    pub test_multiplier: f32,
}

impl Default for Signals {
    fn default() -> Self {
        Self {
            vector_weight: VECTOR_WEIGHT,
            chunk_multipliers: HashMap::new(),
            second_chunk_weight: 0.0,
            test_multiplier: 1.0,
        }
    }
}

/// The answer's two lists, each best first.
pub struct Ranking {
    /// Source files: everything that is not a doc.
    pub files: Vec<RankedFile>,
    pub docs: Vec<RankedFile>,
}

/// Fuse the nearest windows and the keyword matches by rank, and rank files by
/// their best fused chunk. Docs get their own list, so they never take a
/// source file's place.
pub fn rank(vector_hits: Vec<Hit>, keyword_hits: Vec<Hit>, signals: &Signals) -> Ranking {
    // Score completion adds hits out of order, so both lists are put in score
    // order here.
    let mut chunks = fuse(
        best_hit_per_chunk(vector_hits),
        best_hit_per_chunk(keyword_hits),
        signals.vector_weight,
    );
    for hit in &mut chunks {
        if let Some(multiplier) = signals.chunk_multipliers.get(&hit.chunk_id) {
            hit.score *= multiplier;
        }
        if is_test(&hit.path) {
            hit.score *= signals.test_multiplier;
        }
    }

    let mut hits_by_file: HashMap<String, Vec<Hit>> = HashMap::new();
    for hit in chunks {
        hits_by_file.entry(hit.path.clone()).or_default().push(hit);
    }

    let mut files: Vec<RankedFile> = hits_by_file
        .into_iter()
        .filter_map(|(path, hits)| ranked_file(path, hits, signals.second_chunk_weight))
        .collect();
    sort_files(&mut files);
    let (docs, files): (Vec<RankedFile>, Vec<RankedFile>) =
        files.into_iter().partition(|file| is_doc(&file.path));
    Ranking { files, docs }
}

/// Best score first; equal scores by path, so the order is stable.
pub fn sort_files(files: &mut [RankedFile]) {
    files.sort_by(|left, right| {
        right
            .score
            .total_cmp(&left.score)
            .then_with(|| left.path.cmp(&right.path))
    });
}

/// TS v2's test patterns (a test folder, `.test.` or `.spec.` in the name, a
/// `test_` prefix), plus Go's `_test.go`, which v2 missed.
fn is_test(path: &str) -> bool {
    let lower = path.to_lowercase();
    let mut parts: Vec<&str> = lower.split('/').collect();
    let file_name = parts.pop().unwrap_or_default();
    parts.iter().any(|folder| TEST_FOLDERS.contains(folder))
        || file_name.contains(".test.")
        || file_name.contains(".spec.")
        || file_name.starts_with("test_")
        || file_name.ends_with("_test.go")
}

pub fn is_doc(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| DOC_EXTENSIONS.contains(&extension.to_lowercase().as_str()))
}

/// One hit per chunk, scored as its best hit (for vectors, its best window),
/// best first.
fn best_hit_per_chunk(hits: Vec<Hit>) -> Vec<Hit> {
    let mut best_hits: HashMap<i64, Hit> = HashMap::new();
    for hit in hits {
        let is_better = best_hits
            .get(&hit.chunk_id)
            .is_none_or(|existing| hit.score > existing.score);
        if is_better {
            best_hits.insert(hit.chunk_id, hit);
        }
    }
    let mut chunks: Vec<Hit> = best_hits.into_values().collect();
    chunks.sort_by(|left, right| {
        right
            .score
            .total_cmp(&left.score)
            .then_with(|| left.chunk_id.cmp(&right.chunk_id))
    });
    chunks
}

/// Reciprocal-rank fusion of two chunk lists, each best first (D2). A chunk's
/// rank is its position in a list; a list without the chunk adds nothing.
/// Returns one hit per chunk whose score is the fused score.
fn fuse(vector_chunks: Vec<Hit>, keyword_chunks: Vec<Hit>, vector_weight: f32) -> Vec<Hit> {
    let mut fused: HashMap<i64, Hit> = HashMap::new();
    let lists = [
        (vector_chunks, vector_weight),
        (keyword_chunks, 1.0 - vector_weight),
    ];
    for (chunks, weight) in lists {
        for (position, mut hit) in chunks.into_iter().enumerate() {
            let contribution = weight * RANK_CONSTANT / (RANK_CONSTANT + position as f32);
            match fused.get_mut(&hit.chunk_id) {
                Some(existing) => existing.score += contribution,
                None => {
                    hit.score = contribution;
                    fused.insert(hit.chunk_id, hit);
                }
            }
        }
    }
    fused.into_values().collect()
}

/// Build a file's entry from its hits; `None` when it has no hits. Its score is
/// its best chunk's plus `second_chunk_weight` of its second-best chunk's.
fn ranked_file(path: String, mut hits: Vec<Hit>, second_chunk_weight: f32) -> Option<RankedFile> {
    hits.sort_by(|left, right| {
        right
            .score
            .total_cmp(&left.score)
            .then_with(|| left.chunk_id.cmp(&right.chunk_id))
    });
    let second_score = hits.get(1).map_or(0.0, |hit| hit.score);
    let score = hits.first()?.score + second_chunk_weight * second_score;
    Some(RankedFile {
        path,
        score,
        chunk_ids: hits.into_iter().map(|hit| hit.chunk_id).collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hit(path: &str, chunk_id: i64, score: f32) -> Hit {
        Hit {
            path: path.into(),
            chunk_id,
            score,
        }
    }

    fn rank_files(vector_hits: Vec<Hit>, keyword_hits: Vec<Hit>) -> Vec<RankedFile> {
        rank(vector_hits, keyword_hits, &Signals::default()).files
    }

    fn paths(files: &[RankedFile]) -> Vec<&str> {
        files.iter().map(|file| file.path.as_str()).collect()
    }

    #[test]
    fn files_rank_by_their_best_chunk() {
        let files = rank_files(
            vec![
                hit("a.rs", 1, 0.5),
                hit("a.rs", 2, 0.6),
                hit("b.rs", 3, 0.9),
                hit("c.rs", 4, 0.1),
            ],
            Vec::new(),
        );
        assert_eq!(paths(&files), ["b.rs", "a.rs", "c.rs"]);
        assert_eq!(files[1].chunk_ids, [2, 1]);
    }

    #[test]
    fn docs_get_their_own_list_and_take_no_source_place() {
        let ranking = rank(
            vec![
                hit("wiki/guide.md", 1, 0.9),
                hit("docs/ref.TXT", 2, 0.8),
                hit("src/a.rs", 3, 0.7),
                hit("src/b.rs", 4, 0.6),
            ],
            Vec::new(),
            &Signals::default(),
        );
        assert_eq!(paths(&ranking.files), ["src/a.rs", "src/b.rs"]);
        assert_eq!(paths(&ranking.docs), ["wiki/guide.md", "docs/ref.TXT"]);
    }

    #[test]
    fn a_higher_vector_weight_favors_the_vector_list() {
        let vector = || vec![hit("a.rs", 1, 0.9), hit("b.rs", 2, 0.8)];
        let keyword = || vec![hit("b.rs", 2, 3.0), hit("a.rs", 1, 2.0)];
        let even = rank(vector(), keyword(), &Signals::default());
        assert_eq!(even.files[0].score, even.files[1].score);
        let tilted = rank(
            vector(),
            keyword(),
            &Signals {
                vector_weight: PROBE_VECTOR_WEIGHT,
                ..Signals::default()
            },
        );
        assert_eq!(tilted.files[0].path, "a.rs");
        assert!(tilted.files[0].score > tilted.files[1].score);
    }

    #[test]
    fn chunk_multipliers_scale_fused_scores() {
        let signals = Signals {
            chunk_multipliers: HashMap::from([(2, 1.3)]),
            ..Signals::default()
        };
        let ranking = rank(
            vec![hit("a.rs", 1, 0.9), hit("b.rs", 2, 0.8)],
            Vec::new(),
            &signals,
        );
        assert_eq!(paths(&ranking.files), ["b.rs", "a.rs"]);
    }

    #[test]
    fn a_second_chunk_bonus_lifts_files_with_more_evidence() {
        let hits = || {
            vec![
                hit("one.rs", 1, 0.9),
                hit("many.rs", 2, 0.8),
                hit("many.rs", 3, 0.7),
            ]
        };
        let plain = rank_files(hits(), Vec::new());
        assert_eq!(paths(&plain), ["one.rs", "many.rs"]);
        let signals = Signals {
            second_chunk_weight: PROBE_SECOND_CHUNK_WEIGHT,
            ..Signals::default()
        };
        let with_bonus = rank(hits(), Vec::new(), &signals).files;
        assert_eq!(paths(&with_bonus), ["many.rs", "one.rs"]);
    }

    #[test]
    fn test_files_are_recognized_by_folder_and_name() {
        for path in [
            "tests/a.py",
            "src/__tests__/b.ts",
            "pkg/spec/c.rb",
            "src/queue.test.ts",
            "src/queue.spec.tsx",
            "django/test_utils.py",
            "pkg/cache/cache_test.go",
        ] {
            assert!(is_test(path), "{path}");
        }
        for path in [
            "src/testing.rs",
            "src/latest.ts",
            "docs/tests.md",
            "contest/a.py",
        ] {
            assert!(!is_test(path), "{path}");
        }
    }

    #[test]
    fn a_chunk_scores_as_its_best_window() {
        let files = rank_files(
            vec![
                hit("a.rs", 1, 0.2),
                hit("b.rs", 2, 0.5),
                hit("a.rs", 1, 0.7),
            ],
            Vec::new(),
        );
        assert_eq!(files[0].path, "a.rs");
        assert_eq!(files[0].chunk_ids, [1]);
    }

    #[test]
    fn keyword_hits_rank_by_score_whatever_their_order() {
        let files = rank_files(Vec::new(), vec![hit("a.rs", 1, 1.0), hit("b.rs", 2, 3.0)]);
        assert_eq!(paths(&files), ["b.rs", "a.rs"]);
    }

    #[test]
    fn a_chunk_found_by_both_lists_beats_one_found_by_one() {
        let files = rank_files(
            vec![hit("a.rs", 1, 0.9), hit("b.rs", 2, 0.8)],
            vec![hit("b.rs", 2, 3.0), hit("c.rs", 3, 2.0)],
        );
        assert_eq!(paths(&files), ["b.rs", "a.rs", "c.rs"]);
    }

    #[test]
    fn extra_windows_leave_no_gaps_between_vector_ranks() {
        // Chunk 1 fills the first four window positions; chunk 2 still ranks
        // second, level with the second keyword match.
        let files = rank_files(
            vec![
                hit("a.rs", 1, 0.81),
                hit("a.rs", 1, 0.80),
                hit("a.rs", 1, 0.79),
                hit("a.rs", 1, 0.78),
                hit("b.rs", 2, 0.77),
            ],
            vec![hit("c.rs", 3, 5.0), hit("d.rs", 4, 4.0)],
        );
        let score = |path: &str| {
            files
                .iter()
                .find(|file| file.path == path)
                .map(|file| file.score)
        };
        assert_eq!(score("b.rs"), score("d.rs"));
    }
}
