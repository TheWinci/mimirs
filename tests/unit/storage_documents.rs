use super::*;

#[test]
fn documents_roundtrip_rollback_and_cleanup() {
    let dir = tempfile::tempdir().unwrap();
    let mut db = crate::storage::open(&dir.path().join("index.db"))
        .unwrap()
        .connection;
    let analysis = crate::analysis::extract(crate::source::SourceFile {
        path: "a.rs".into(),
        text: "/// Hi\nfn f() { g(); g(); }".into(),
    })
    .unwrap();
    let descriptions =
        crate::retrieval::render::render(&crate::retrieval::project(&analysis).unwrap());
    let documents: Vec<_> = descriptions
        .into_iter()
        .map(|d| Document {
            owner: d.owner,
            part: 0,
            text: d
                .facts
                .iter()
                .map(|c| c.text.as_str())
                .collect::<Vec<_>>()
                .join("\n"),
            evidence: d.facts.into_iter().flat_map(|c| c.evidence).collect(),
        })
        .collect();
    let vectors = vec![vec![1.0; DIMENSION]; documents.len()];
    save(
        &mut db,
        &analysis,
        Batch {
            documents: &documents,
            vectors: &vectors,
            policy: "test",
        },
    )
    .unwrap();
    assert_eq!(load(&db, "a.rs", "test").unwrap(), documents);
    let mut invalid = documents.clone();
    invalid[0].evidence[0].span.end = 999;
    assert!(
        save(
            &mut db,
            &analysis,
            Batch {
                documents: &invalid,
                vectors: &vectors,
                policy: "test"
            }
        )
        .is_err()
    );
    assert_eq!(load(&db, "a.rs", "test").unwrap(), documents);
    save(
        &mut db,
        &analysis,
        Batch {
            documents: &[],
            vectors: &[],
            policy: "test",
        },
    )
    .unwrap();
    assert!(load(&db, "a.rs", "test").unwrap().is_empty());
    assert_eq!(
        db.query_row("SELECT count(*) FROM document_embeddings", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    save(
        &mut db,
        &analysis,
        Batch {
            documents: &documents,
            vectors: &vectors,
            policy: "test",
        },
    )
    .unwrap();
    crate::storage::invalidate(&mut db, "a.rs").unwrap();
    assert_eq!(
        db.query_row("SELECT count(*) FROM document_embeddings", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn search_collapses_many_parts_and_retains_indexed_evidence() {
    let dir = tempfile::tempdir().unwrap();
    let mut db = crate::storage::open(&dir.path().join("index.db"))
        .unwrap()
        .connection;
    let budget =
        crate::retrieval::split::TokenBudget::new(crate::test_support::tokenizer(512)).unwrap();
    let policy = crate::storage::policy::document_policy(&budget);
    crate::storage::policy::configure(&mut db, crate::storage::policy::Mode::Facts, Some(&policy))
        .unwrap();
    let analysis = crate::analysis::extract(crate::source::SourceFile {
        path: "deleted.rs".into(),
        text: "fn same() {}\nmod m { fn same() {} }".into(),
    })
    .unwrap();
    let base = budget
        .split(&crate::retrieval::render::render(
            &crate::retrieval::project(&analysis).unwrap(),
        ))
        .unwrap();
    let mut documents = Vec::new();
    for part in 0..80 {
        let mut d = base[0].clone();
        d.part = part;
        documents.push(d);
    }
    documents.extend_from_slice(&base[1..]);
    let vectors: Vec<_> = documents
        .iter()
        .map(|d| {
            let mut v = vec![0.0; DIMENSION];
            v[0] = 1.0;
            v[1] = if d.owner == Some(0) { 0.0 } else { 1.0 };
            v
        })
        .collect();
    save(
        &mut db,
        &analysis,
        Batch {
            documents: &documents,
            vectors: &vectors,
            policy: &policy,
        },
    )
    .unwrap();
    let mut query = vec![0.0; DIMENSION];
    query[0] = 1.0;
    let hits = crate::storage::nearest(&db, &query, 3).unwrap();
    assert_eq!(hits.len(), 3);
    assert_eq!(hits[0].similarity, 1.0);
    let owners: std::collections::HashSet<_> = hits
        .iter()
        .map(|h| h.indexed.as_ref().unwrap().owner)
        .collect();
    assert_eq!(owners.len(), 3);
    assert_eq!(hits[0].line_end, 1);
    assert!(
        hits.iter()
            .all(|h| !h.indexed.as_ref().unwrap().spans.is_empty())
    );
    db.execute(
        "UPDATE retrieval_documents SET policy='broken' WHERE ordinal=0",
        [],
    )
    .unwrap();
    assert!(crate::storage::nearest(&db, &query, 3).is_err());
}

#[test]
fn policy_rejects_missing_vectors_and_mixed_raw_rust() {
    let dir = tempfile::tempdir().unwrap();
    let mut db = crate::storage::open(&dir.path().join("index.db"))
        .unwrap()
        .connection;
    let budget =
        crate::retrieval::split::TokenBudget::new(crate::test_support::tokenizer(512)).unwrap();
    let policy = crate::storage::policy::document_policy(&budget);
    crate::storage::policy::configure(&mut db, crate::storage::policy::Mode::Facts, Some(&policy))
        .unwrap();
    let analysis = crate::analysis::extract(crate::source::SourceFile {
        path: "a.rs".into(),
        text: "fn a() {}".into(),
    })
    .unwrap();
    let docs = budget
        .split(&crate::retrieval::render::render(
            &crate::retrieval::project(&analysis).unwrap(),
        ))
        .unwrap();
    save(
        &mut db,
        &analysis,
        Batch {
            documents: &docs,
            vectors: &vec![vec![1.0; DIMENSION]; docs.len()],
            policy: &policy,
        },
    )
    .unwrap();
    db.execute("DELETE FROM document_embeddings", []).unwrap();
    assert!(crate::storage::policy::read(&db).is_err());
    let chunks = crate::chunk::of(&analysis.source);
    crate::storage::save_file_with_analysis(
        &mut db,
        &analysis.source,
        &chunks,
        &[],
        &[],
        Some(&analysis),
    )
    .unwrap();
    assert!(crate::storage::policy::read(&db).is_err());
}
