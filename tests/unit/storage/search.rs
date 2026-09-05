use super::*;

fn save_vectors(connection: &mut Connection, path: &str, text: &str, vectors: &[Vec<f32>]) {
    let analysis = crate::analysis::extract(source(path, text)).unwrap();
    let budget =
        crate::retrieval::split::TokenBudget::new(crate::test_support::tokenizer(512)).unwrap();
    let policy = policy::document_policy(&budget);
    let docs = crate::retrieval::source::documents(&analysis, &budget).unwrap();
    documents::save(
        connection,
        &analysis,
        documents::Batch {
            documents: &docs,
            vectors,
            policy: &policy,
        },
    )
    .unwrap();
}

#[test]
fn nearest_matches_scalar_ranking_and_limit_boundaries() {
    let dir = TempDir::new().unwrap();
    let mut connection = open(&dir.path().join("index.db")).unwrap().connection;
    let vectors = [
        vector(1.0, 0.0),
        vector(-1.0, 1.0),
        vector(1.0, 1.0),
        vector(-1.0, 0.0),
    ];
    save_vectors(
        &mut connection,
        "a.rs",
        "fn near() {}\nfn far() {}\nfn middle() {}\nfn opposite() {}",
        &vectors,
    );
    let query = vector(1.0, 0.0);
    let mut expected: Vec<_> = vectors
        .iter()
        .enumerate()
        .map(|(i, v)| {
            (
                i,
                crate::test_support::cosine_similarity(&query, v).unwrap() as f64,
            )
        })
        .collect();
    expected.sort_by(|a, b| b.1.total_cmp(&a.1));
    for limit in [1, 2, 4, 5, 4096] {
        let results = nearest(&connection, &query, limit).unwrap();
        assert_eq!(results.len(), limit.min(4));
        for (result, (owner, score)) in results.iter().zip(&expected) {
            assert!((result.similarity - score).abs() < 1e-6);
            assert_eq!(result.path, "a.rs");
            assert_eq!(result.indexed.owner, Some(*owner));
            assert_eq!(
                (result.line_start, result.line_end),
                (*owner as i64 + 1, *owner as i64 + 1)
            );
        }
    }
    let actual: Vec<(i64, f32)> = connection.prepare("SELECT d.ordinal, 1.0-e.distance FROM document_embeddings e JOIN retrieval_documents d ON d.id=e.document_id WHERE e.embedding MATCH ?1 AND k=10 ORDER BY e.distance").unwrap()
        .query_map([vector_bytes(&query)], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().collect::<rusqlite::Result<_>>().unwrap();
    for ((ordinal, score), (expected_ordinal, expected_score)) in actual.iter().zip(expected) {
        assert_eq!(*ordinal, expected_ordinal as i64);
        assert!((*score as f64 - expected_score).abs() < 1e-6);
    }
}

#[test]
fn nearest_keeps_same_named_entities_separate() {
    let dir = TempDir::new().unwrap();
    let mut connection = open(&dir.path().join("index.db")).unwrap().connection;
    save_vectors(
        &mut connection,
        "nested/file.rs",
        "fn same() {}\nfn same() {}",
        &[vector(0.0, 1.0), vector(1.0, 0.0)],
    );
    let results = nearest(&connection, &vector(1.0, 0.0), 2).unwrap();
    assert_eq!(
        results
            .iter()
            .map(|r| (r.line_start, r.line_end))
            .collect::<Vec<_>>(),
        [(2, 2), (1, 1)]
    );
    assert!(
        results
            .iter()
            .all(|r| r.path == "nested/file.rs" && r.text.contains("fn same() {}"))
    );
}

#[test]
fn nearest_sorts_by_unrounded_score_before_path() {
    let dir = TempDir::new().unwrap();
    let mut connection = open(&dir.path().join("index.db")).unwrap().connection;
    for (path, y) in [("a.rs", 0.005), ("z.rs", 0.0)] {
        save_vectors(&mut connection, path, "fn a() {}", &[vector(1.0, y)]);
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
    let mut connection = open(&dir.path().join("index.db")).unwrap().connection;
    for query in [vec![], vec![0.0; 383], vector(f32::INFINITY, 0.0)] {
        assert!(nearest(&connection, &query, 5).is_err());
    }
    for limit in [0, 4097] {
        assert!(nearest(&connection, &vector(1.0, 0.0), limit).is_err());
    }
    save_vectors(&mut connection, "a.rs", "fn a() {}", &[vector(1.0, 0.0)]);
    connection
        .execute_batch("DROP TABLE document_embeddings")
        .unwrap();
    assert!(nearest(&connection, &vector(1.0, 0.0), 5).is_err());
}

#[test]
fn text_and_rust_share_ranking_and_saved_source_evidence() {
    let dir = TempDir::new().unwrap();
    let mut connection = open(&dir.path().join("index.db")).unwrap().connection;
    save_vectors(
        &mut connection,
        "a.txt",
        "first paragraph\nkeeps both lines\n\nsecond paragraph",
        &[vector(0.0, 1.0), vector(1.0, 0.0)],
    );
    save_vectors(&mut connection, "b.rs", "fn f() {}", &[vector(1.0, 1.0)]);
    let hits = nearest(&connection, &vector(1.0, 0.0), 5).unwrap();
    assert_eq!(hits.len(), 2);
    assert_eq!(hits[0].path, "a.txt");
    assert_eq!(hits[0].text, "a.txt\nsecond paragraph");
    assert!(hits[0].indexed.owner.is_none());
    assert!(hits.iter().all(|h| !h.indexed.spans.is_empty()));
}
