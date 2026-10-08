use std::collections::HashMap;
use std::path::Path;

use crate::store::Hit;

/// Share of the fused score that comes from the vector list; the keyword list
/// gives the rest.
const VECTOR_WEIGHT: f32 = 0.5;
/// Share of a file's second-best chunk score added to its best, so a file
/// split into several matching symbols is not beaten by one strong chunk
/// (TS v2's value with score completion).
const SECOND_CHUNK_WEIGHT: f32 = 0.25;
/// Weight of the whole-file BM25 list, next to 0.5 for each chunk list
/// (ranking plan D7).
const FILE_MATCH_WEIGHT: f32 = 0.5;
/// Factor for chunks in test files, so source files rank first (TS v2's value).
const TEST_MULTIPLIER: f32 = 0.85;
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

/// The answer's two lists, each best first.
pub struct Ranking {
    /// Source files: everything that is not a doc.
    pub files: Vec<RankedFile>,
    pub docs: Vec<RankedFile>,
}

/// Fuse the nearest windows and the keyword matches by rank, and rank files by
/// their best fused chunk plus a quarter of their second-best; chunks in test
/// files count less. A found file also gains by its rank in `file_matches`,
/// the whole-file keyword matches, best first. Docs get their own list, so
/// they never take a source file's place.
/// `chunk_multipliers` scales fused chunk scores by chunk ID before chunks are
/// grouped into files; chunks not listed keep their score.
pub fn rank(
    vector_hits: Vec<Hit>,
    keyword_hits: Vec<Hit>,
    file_matches: &[String],
    chunk_multipliers: &HashMap<i64, f32>,
) -> Ranking {
    // Score completion adds hits out of order, so both lists are put in score
    // order here.
    let mut chunks = fuse(
        best_hit_per_chunk(vector_hits),
        best_hit_per_chunk(keyword_hits),
    );
    for hit in &mut chunks {
        if let Some(multiplier) = chunk_multipliers.get(&hit.chunk_id) {
            hit.score *= multiplier;
        }
        if is_test(&hit.path) {
            hit.score *= TEST_MULTIPLIER;
        }
    }

    let mut hits_by_file: HashMap<String, Vec<Hit>> = HashMap::new();
    for hit in chunks {
        hits_by_file.entry(hit.path.clone()).or_default().push(hit);
    }

    let mut files: Vec<RankedFile> = hits_by_file
        .into_iter()
        .filter_map(|(path, hits)| ranked_file(path, hits))
        .collect();
    // Only files the chunk lists found gain: a file found by its whole text
    // alone has no chunk to show.
    for (position, path) in file_matches.iter().enumerate() {
        if let Some(file) = files.iter_mut().find(|file| &file.path == path) {
            file.score += FILE_MATCH_WEIGHT * RANK_CONSTANT / (RANK_CONSTANT + position as f32);
        }
    }
    sort_files(&mut files);
    let (docs, files): (Vec<RankedFile>, Vec<RankedFile>) =
        files.into_iter().partition(|file| is_doc(&file.path));
    Ranking { files, docs }
}

/// Best score first; equal scores by path, so the order is stable.
fn sort_files(files: &mut [RankedFile]) {
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

fn is_doc(path: &str) -> bool {
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
fn fuse(vector_chunks: Vec<Hit>, keyword_chunks: Vec<Hit>) -> Vec<Hit> {
    let mut fused: HashMap<i64, Hit> = HashMap::new();
    let lists = [
        (vector_chunks, VECTOR_WEIGHT),
        (keyword_chunks, 1.0 - VECTOR_WEIGHT),
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
/// its best chunk's plus `SECOND_CHUNK_WEIGHT` of its second-best chunk's.
fn ranked_file(path: String, mut hits: Vec<Hit>) -> Option<RankedFile> {
    hits.sort_by(|left, right| {
        right
            .score
            .total_cmp(&left.score)
            .then_with(|| left.chunk_id.cmp(&right.chunk_id))
    });
    let second_score = hits.get(1).map_or(0.0, |hit| hit.score);
    let score = hits.first()?.score + SECOND_CHUNK_WEIGHT * second_score;
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
        rank(vector_hits, keyword_hits, &[], &HashMap::new()).files
    }

    fn paths(files: &[RankedFile]) -> Vec<&str> {
        files.iter().map(|file| file.path.as_str()).collect()
    }

    #[test]
    fn files_rank_by_their_best_chunk() {
        let files = rank_files(
            vec![
                hit("a.rs", 1, 0.5),
                hit("b.rs", 3, 0.9),
                hit("c.rs", 4, 0.1),
            ],
            Vec::new(),
        );
        assert_eq!(paths(&files), ["b.rs", "a.rs", "c.rs"]);
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
            &[],
            &HashMap::new(),
        );
        assert_eq!(paths(&ranking.files), ["src/a.rs", "src/b.rs"]);
        assert_eq!(paths(&ranking.docs), ["wiki/guide.md", "docs/ref.TXT"]);
    }

    #[test]
    fn chunk_multipliers_scale_fused_scores() {
        let ranking = rank(
            vec![hit("a.rs", 1, 0.9), hit("b.rs", 2, 0.8)],
            Vec::new(),
            &[],
            &HashMap::from([(2, 1.3)]),
        );
        assert_eq!(paths(&ranking.files), ["b.rs", "a.rs"]);
    }

    #[test]
    fn a_second_chunk_bonus_lifts_files_with_more_evidence() {
        let files = rank_files(
            vec![
                hit("one.rs", 1, 0.9),
                hit("many.rs", 2, 0.8),
                hit("many.rs", 3, 0.7),
            ],
            Vec::new(),
        );
        assert_eq!(paths(&files), ["many.rs", "one.rs"]);
        assert_eq!(files[0].chunk_ids, [2, 3]);
    }

    #[test]
    fn test_files_rank_below_equal_source_files() {
        let files = rank_files(
            vec![hit("tests/a.rs", 1, 0.9), hit("src/b.rs", 2, 0.8)],
            Vec::new(),
        );
        assert_eq!(paths(&files), ["src/b.rs", "tests/a.rs"]);
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
    fn whole_file_matches_lift_found_files_only() {
        let ranking = rank(
            vec![hit("a.rs", 1, 0.9), hit("b.rs", 2, 0.8)],
            Vec::new(),
            &["b.rs".to_string(), "c.rs".to_string()],
            &HashMap::new(),
        );
        assert_eq!(paths(&ranking.files), ["b.rs", "a.rs"]);
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
