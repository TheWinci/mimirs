use super::*;

#[test]
fn nearest_matches_scalar_ranking_and_limit_boundaries() {
    let dir = TempDir::new().unwrap();
    let mut connection = open(&dir.path().join("index.db")).unwrap().connection;
    let source = source("a.rs", "same\nsame\nsame\nsame");
    let chunks = crate::chunk::of(&source);
    let windows = crate::window::of(&chunks[0]);
    let vectors = [
        vector(1.0, 0.0),
        vector(-1.0, 1.0),
        vector(1.0, 1.0),
        vector(-1.0, 0.0),
    ];
    save_file(&mut connection, &source, &chunks, &windows, &vectors).unwrap();
    let query = vector(1.0, 0.0);
    let mut expected = vectors
        .iter()
        .map(|value| crate::test_support::cosine_similarity(&query, value).unwrap() as f64)
        .collect::<Vec<_>>();
    expected.sort_by(|a, b| b.total_cmp(a));
    for limit in [1, 2, 4, 5, 4096] {
        let results = nearest(&connection, &query, limit).unwrap();
        assert_eq!(results.len(), limit.min(4));
        for (result, score) in results.iter().zip(&expected) {
            assert!((result.similarity - score).abs() < 1e-6);
            assert_eq!(result.path, "a.rs");
            assert_eq!(result.text, "same");
            assert_eq!((result.line_start, result.line_end), (1, 4));
        }
    }
}

#[test]
fn nearest_joins_each_window_to_its_own_chunk() {
    use crate::{chunk::Chunk, window::Window};
    let dir = TempDir::new().unwrap();
    let mut connection = open(&dir.path().join("index.db")).unwrap().connection;
    let source = source("nested/file.rs", "first\nsame\nlast\nsame");
    let chunks = [
        Chunk {
            source: &source,
            text: "first\nsame\n".to_owned(),
            byte_start: 0,
            byte_end: 11,
            line_start: 1,
            line_end: 2,
        },
        Chunk {
            source: &source,
            text: "last\nsame".to_owned(),
            byte_start: 11,
            byte_end: 20,
            line_start: 3,
            line_end: 4,
        },
    ];
    let windows = [
        Window {
            chunk: &chunks[0],
            text: "same".to_owned(),
        },
        Window {
            chunk: &chunks[1],
            text: "same".to_owned(),
        },
    ];
    save_file(
        &mut connection,
        &source,
        &chunks,
        &windows,
        &[vector(0.0, 1.0), vector(1.0, 0.0)],
    )
    .unwrap();
    let results = nearest(&connection, &vector(1.0, 0.0), 2).unwrap();
    assert_eq!(
        results
            .iter()
            .map(|result| (result.line_start, result.line_end))
            .collect::<Vec<_>>(),
        [(3, 4), (1, 2)]
    );
    assert!(
        results
            .iter()
            .all(|result| result.path == "nested/file.rs" && result.text == "same")
    );
}

#[test]
fn nearest_sorts_by_unrounded_score_before_path() {
    let dir = TempDir::new().unwrap();
    let mut connection = open(&dir.path().join("index.db")).unwrap().connection;
    for (path, y) in [("a.rs", 0.005), ("z.rs", 0.0)] {
        let source = source(path, "line");
        let chunks = crate::chunk::of(&source);
        let windows = crate::window::of(&chunks[0]);
        save_file(
            &mut connection,
            &source,
            &chunks,
            &windows,
            &[vector(1.0, y)],
        )
        .unwrap();
    }
    let results = nearest(&connection, &vector(1.0, 0.0), 2).unwrap();
    assert_eq!(results[0].path, "z.rs");
    assert!(results[0].similarity > results[1].similarity);
    assert_eq!(
        format!("{:.4}", results[0].similarity),
        format!("{:.4}", results[1].similarity)
    );
}

#[test]
fn nearest_reports_query_and_database_errors() {
    let dir = TempDir::new().unwrap();
    let connection = open(&dir.path().join("index.db")).unwrap().connection;
    for query in [vec![], vec![0.0; 383], vector(f32::INFINITY, 0.0)] {
        assert!(nearest(&connection, &query, 5).is_err());
    }
    for limit in [0, 4097] {
        assert!(nearest(&connection, &vector(1.0, 0.0), limit).is_err());
    }
    connection.execute_batch("DROP TABLE windows").unwrap();
    let error = nearest(&connection, &vector(1.0, 0.0), 5).unwrap_err();
    assert!(format!("{error:#}").contains("cannot retrieve nearest windows"));
}

#[test]
fn vec0_ranking_matches_scalar_cosine() {
    let dir = TempDir::new().unwrap();
    let mut connection = open(&dir.path().join("index.db")).unwrap().connection;
    let source = source("a.rs", "near\nfar\nmiddle\nopposite");
    let chunks = crate::chunk::of(&source);
    let windows = crate::window::of(&chunks[0]);
    let vectors = vec![
        vector(1.0, 0.0),
        vector(-1.0, 1.0),
        vector(1.0, 1.0),
        vector(-1.0, 0.0),
    ];
    save_file(&mut connection, &source, &chunks, &windows, &vectors).unwrap();
    let query = vector(1.0, 0.0);
    let mut expected: Vec<_> = vectors
        .iter()
        .enumerate()
        .map(|(i, v)| {
            (
                i as i64,
                crate::test_support::cosine_similarity(&query, v).unwrap(),
            )
        })
        .collect();
    expected.sort_by(|a, b| b.1.total_cmp(&a.1));
    let mut statement = connection.prepare("SELECT w.ordinal, 1.0 - e.distance FROM window_embeddings e JOIN windows w ON w.id = e.window_id WHERE e.embedding MATCH ?1 AND k = 10 ORDER BY e.distance").unwrap();
    let actual: Vec<(i64, f32)> = statement
        .query_map([vector_bytes(&query)], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(actual.len(), expected.len());
    for (actual, expected) in actual.iter().zip(&expected) {
        assert_eq!(actual.0, expected.0);
        assert!(
            (actual.1 - expected.1).abs() < 1e-6,
            "{actual:?} vs {expected:?}"
        );
    }
}
