use std::collections::HashMap;

use crate::store::Hit;

/// Share of the fused score that comes from the vector list; the keyword list
/// gives the rest.
const VECTOR_WEIGHT: f32 = 0.5;
/// Reciprocal-rank constant: rank 0 counts 1, rank 60 counts half.
const RANK_CONSTANT: f32 = 60.0;

/// A file in the answer and the chunks that matched in it.
pub struct RankedFile {
    pub path: String,
    /// The fused score of the file's best chunk.
    pub score: f32,
    /// The file's matching chunks, best first.
    pub chunk_ids: Vec<i64>,
}

/// Fuse the nearest windows and the keyword matches by rank, rank files by
/// their best fused chunk, and keep the `max_files` best.
pub fn rank(vector_hits: Vec<Hit>, keyword_hits: Vec<Hit>, max_files: usize) -> Vec<RankedFile> {
    let chunks = fuse(best_window_per_chunk(vector_hits), keyword_hits);

    let mut hits_by_file: HashMap<String, Vec<Hit>> = HashMap::new();
    for hit in chunks {
        hits_by_file.entry(hit.path.clone()).or_default().push(hit);
    }

    let mut files: Vec<RankedFile> = hits_by_file
        .into_iter()
        .filter_map(|(path, hits)| ranked_file(path, hits))
        .collect();
    files.sort_by(|left, right| {
        right
            .score
            .total_cmp(&left.score)
            .then_with(|| left.path.cmp(&right.path))
    });
    files.truncate(max_files);
    files
}

/// One hit per chunk, scored as its best window, best first.
fn best_window_per_chunk(hits: Vec<Hit>) -> Vec<Hit> {
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

/// Build a file's entry from its hits; `None` when it has no hits.
fn ranked_file(path: String, mut hits: Vec<Hit>) -> Option<RankedFile> {
    hits.sort_by(|left, right| {
        right
            .score
            .total_cmp(&left.score)
            .then_with(|| left.chunk_id.cmp(&right.chunk_id))
    });
    let score = hits.first()?.score;
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

    fn paths(files: &[RankedFile]) -> Vec<&str> {
        files.iter().map(|file| file.path.as_str()).collect()
    }

    #[test]
    fn files_rank_by_their_best_chunk() {
        let files = rank(
            vec![
                hit("a.rs", 1, 0.5),
                hit("a.rs", 2, 0.6),
                hit("b.rs", 3, 0.9),
                hit("c.rs", 4, 0.1),
            ],
            Vec::new(),
            2,
        );
        assert_eq!(paths(&files), ["b.rs", "a.rs"]);
        assert_eq!(files[1].chunk_ids, [2, 1]);
    }

    #[test]
    fn a_chunk_scores_as_its_best_window() {
        let files = rank(
            vec![
                hit("a.rs", 1, 0.2),
                hit("b.rs", 2, 0.5),
                hit("a.rs", 1, 0.7),
            ],
            Vec::new(),
            20,
        );
        assert_eq!(files[0].path, "a.rs");
        assert_eq!(files[0].chunk_ids, [1]);
    }

    #[test]
    fn a_chunk_found_by_both_lists_beats_one_found_by_one() {
        let files = rank(
            vec![hit("a.rs", 1, 0.9), hit("b.rs", 2, 0.8)],
            vec![hit("b.rs", 2, 3.0), hit("c.rs", 3, 2.0)],
            20,
        );
        assert_eq!(paths(&files), ["b.rs", "a.rs", "c.rs"]);
    }

    #[test]
    fn extra_windows_leave_no_gaps_between_vector_ranks() {
        // Chunk 1 fills the first four window positions; chunk 2 still ranks
        // second, level with the second keyword match.
        let files = rank(
            vec![
                hit("a.rs", 1, 0.81),
                hit("a.rs", 1, 0.80),
                hit("a.rs", 1, 0.79),
                hit("a.rs", 1, 0.78),
                hit("b.rs", 2, 0.77),
            ],
            vec![hit("c.rs", 3, 5.0), hit("d.rs", 4, 4.0)],
            20,
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
