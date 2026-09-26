use std::collections::HashMap;

use crate::store::Hit;

/// Consecutive lines of one file, made of one chunk or neighbouring chunks.
pub struct Excerpt {
    pub start_line: usize,
    pub end_line: usize,
    pub text: String,
}

/// A file in the answer, with its matching code in line order.
pub struct RankedFile {
    pub path: String,
    /// The score of the file's best chunk.
    pub score: f32,
    /// Line number and text of the first non-blank line of the best chunk.
    pub summary_line: usize,
    pub summary: String,
    pub excerpts: Vec<Excerpt>,
}

/// Rank files by their best chunk and keep the `max_files` best.
pub fn rank(hits: Vec<Hit>, max_files: usize) -> Vec<RankedFile> {
    // A chunk with several matching windows scores as its best window.
    let mut best_hits: HashMap<i64, Hit> = HashMap::new();
    for hit in hits {
        let is_better = best_hits
            .get(&hit.chunk_id)
            .is_none_or(|existing| hit.score > existing.score);
        if is_better {
            best_hits.insert(hit.chunk_id, hit);
        }
    }

    let mut hits_by_file: HashMap<String, Vec<Hit>> = HashMap::new();
    for hit in best_hits.into_values() {
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

/// Build a file's entry from its hits; `None` when it has no hits.
fn ranked_file(path: String, mut hits: Vec<Hit>) -> Option<RankedFile> {
    let best = hits
        .iter()
        .max_by(|left, right| left.score.total_cmp(&right.score))?;
    let score = best.score;
    let (summary_line, summary) = first_non_blank_line(best);

    hits.sort_by_key(|hit| hit.start_line);
    let mut excerpts: Vec<Excerpt> = Vec::new();
    for hit in hits {
        match excerpts.last_mut() {
            Some(previous) if previous.end_line + 1 == hit.start_line => {
                previous.end_line = hit.end_line;
                previous.text.push_str(&hit.text);
            }
            _ => excerpts.push(Excerpt {
                start_line: hit.start_line,
                end_line: hit.end_line,
                text: hit.text,
            }),
        }
    }

    Some(RankedFile {
        path,
        score,
        summary_line,
        summary,
        excerpts,
    })
}

fn first_non_blank_line(hit: &Hit) -> (usize, String) {
    for (offset, line) in hit.text.lines().enumerate() {
        if !line.trim().is_empty() {
            return (hit.start_line + offset, line.trim().to_string());
        }
    }
    (hit.start_line, String::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hit(path: &str, chunk_id: i64, lines: (usize, usize), score: f32) -> Hit {
        Hit {
            path: path.into(),
            chunk_id,
            start_line: lines.0,
            end_line: lines.1,
            text: format!("\n  chunk {chunk_id}\n"),
            score,
        }
    }

    #[test]
    fn files_rank_by_their_best_chunk() {
        let files = rank(
            vec![
                hit("a.rs", 1, (1, 5), 0.5),
                hit("a.rs", 2, (20, 30), 0.6),
                hit("b.rs", 3, (1, 5), 0.9),
                hit("c.rs", 4, (1, 5), 0.1),
            ],
            2,
        );
        let paths: Vec<&str> = files.iter().map(|file| file.path.as_str()).collect();
        assert_eq!(paths, ["b.rs", "a.rs"]);
        assert_eq!(files[1].score, 0.6);
        assert_eq!(
            (files[1].summary_line, files[1].summary.as_str()),
            (21, "chunk 2")
        );
    }

    #[test]
    fn a_chunk_scores_as_its_best_window() {
        let files = rank(
            vec![hit("a.rs", 1, (1, 5), 0.2), hit("a.rs", 1, (1, 5), 0.7)],
            20,
        );
        assert_eq!(files[0].score, 0.7);
        assert_eq!(files[0].excerpts.len(), 1);
    }

    #[test]
    fn neighbouring_chunks_merge_into_one_excerpt_in_line_order() {
        let files = rank(
            vec![
                hit("a.rs", 3, (11, 20), 0.9),
                hit("a.rs", 1, (1, 10), 0.5),
                hit("a.rs", 7, (40, 50), 0.4),
            ],
            20,
        );
        let ranges: Vec<(usize, usize)> = files[0]
            .excerpts
            .iter()
            .map(|excerpt| (excerpt.start_line, excerpt.end_line))
            .collect();
        assert_eq!(ranges, [(1, 20), (40, 50)]);
    }
}
