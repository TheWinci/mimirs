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
