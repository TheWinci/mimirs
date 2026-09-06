use super::*;

fn reference() -> serde_json::Value {
    serde_json::from_str(include_str!(
        "../../../benchmarks/versions/port/reference.json"
    ))
    .unwrap()
}

#[test]
fn terms_and_safe_queries_match_ts_reference() {
    for case in reference()["terms"].as_array().unwrap() {
        let text = case["text"].as_str().unwrap();
        assert_eq!(serde_json::json!(terms(text)), case["terms"], "{text}");
        assert_eq!(serde_json::json!(query(text)), case["fts_query"], "{text}");
    }
    assert_eq!(terms("𐐀 a ² ７ ᾈ"), ["𐐨", "2", "7"]);
}

#[test]
fn native_bm25_matches_ts_scores_membership_and_ties() {
    let reference = reference();
    let dir = tempfile::tempdir().unwrap();
    let db = crate::storage::open(&dir.path().join("index.db"))
        .unwrap()
        .connection;
    // The fixture supplies equivalent windows directly, isolating the lexical
    // algorithm from source extraction and token-window changes in later slices.
    db.pragma_update(None, "foreign_keys", false).unwrap();
    for window in reference["windows"].as_array().unwrap() {
        let id = window["id"].as_i64().unwrap();
        let path = window["path"].as_str().unwrap();
        db.execute(
            "INSERT OR IGNORE INTO files(id, path) VALUES (?1, ?2)",
            params![id, path],
        )
        .unwrap();
        db.execute("INSERT INTO retrieval_documents(id, file_id, ordinal, owner, kind, part, policy, text, content_hash, evidence)
            VALUES (?1, (SELECT id FROM files WHERE path=?2), ?1, NULL, 'file', 0, 'fixture', ?3, '', ?4)",
            params![id, path, window["text"].as_str().unwrap(), serde_json::json!([{"span":{"start":window["startOffset"],"end":window["endOffset"]}}]).to_string()]).unwrap();
        insert(
            &db,
            id,
            path,
            window["sourceChunk"]["name"].as_str(),
            window["text"].as_str().unwrap(),
        )
        .unwrap();
    }
    for case in reference["nativeCases"].as_array().unwrap() {
        let request = &case["request"];
        let hits = candidates(
            &db,
            request["query"].as_str().unwrap(),
            request["limit"].as_u64().unwrap() as usize,
        )
        .unwrap();
        let expected = case["baseline"]["baselineLexical"].as_array().unwrap();
        assert_eq!(hits.len(), expected.len(), "{request}");
        for (hit, expected) in hits.iter().zip(expected) {
            assert_eq!(hit.id, expected["id"].as_i64().unwrap(), "{request}");
            let score = expected["lexicalScore"].as_f64().unwrap();
            assert!(
                (hit.score - score).abs() <= 1e-12 + 1e-9 * score.abs(),
                "{request}: {} != {score}",
                hit.score
            );
        }
    }
}

#[test]
fn lexical_projection_follows_snapshot_lifecycle() {
    use crate::storage::{
        documents::{Batch, save},
        invalidate, reconcile,
    };
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("index.db");
    let mut db = crate::storage::open(&path).unwrap().connection;
    let budget =
        crate::retrieval::split::TokenBudget::new(crate::test_support::tokenizer(512)).unwrap();
    let policy = crate::storage::policy::document_policy(&budget);
    let analysis = crate::analysis::extract(crate::source::SourceFile {
        path: "src/worker.rs".into(),
        text: "fn recoverArchive() { manifest(); }".into(),
    })
    .unwrap();
    let docs = crate::retrieval::source::documents(&analysis, &budget).unwrap();
    let vectors = vec![vec![1.0; crate::embedding::DIMENSION]; docs.len()];
    let batch = || Batch {
        documents: &docs,
        vectors: &vectors,
        policy: &policy,
    };
    save(&mut db, &analysis, batch()).unwrap();
    let before = candidates(&db, "recoverArchive", 100).unwrap();
    assert!(!before.is_empty());
    drop(db);
    let mut db = crate::storage::open(&path).unwrap().connection;
    assert_eq!(
        before[0].score,
        candidates(&db, "recoverArchive", 100).unwrap()[0].score
    );
    // Failure after the old rows were deleted rolls back their FTS projection.
    assert!(
        save(
            &mut db,
            &analysis,
            Batch {
                documents: &docs,
                vectors: &[vec![0.0]],
                policy: &policy
            }
        )
        .is_err()
    );
    assert_eq!(
        before[0].score,
        candidates(&db, "recoverArchive", 100).unwrap()[0].score
    );
    let replacement = crate::analysis::extract(crate::source::SourceFile {
        path: analysis.source.path.clone(),
        text: "fn replacement() {}".into(),
    })
    .unwrap();
    let replacement_docs = crate::retrieval::source::documents(&replacement, &budget).unwrap();
    save(
        &mut db,
        &replacement,
        Batch {
            documents: &replacement_docs,
            vectors: &vec![vec![1.0; crate::embedding::DIMENSION]; replacement_docs.len()],
            policy: &policy,
        },
    )
    .unwrap();
    assert!(candidates(&db, "recoverArchive", 100).unwrap().is_empty());
    assert!(!candidates(&db, "replacement", 100).unwrap().is_empty());
    invalidate(&mut db, &analysis.source.path).unwrap();
    assert!(candidates(&db, "replacement", 100).unwrap().is_empty());
    save(&mut db, &analysis, batch()).unwrap();
    reconcile(&mut db, &[]).unwrap();
    assert!(candidates(&db, "recoverArchive", 100).unwrap().is_empty());
    assert_eq!(
        db.query_row("SELECT count(*) FROM document_fts", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
}
