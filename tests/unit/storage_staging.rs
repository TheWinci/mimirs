use super::*;
use std::sync::Arc;

fn fixture() -> (Analysis, Vec<Document>, WindowPlan, Vec<Vec<f32>>, String) {
    let analysis = crate::analysis::extract(crate::source::SourceFile {
        path: "a.rs".into(),
        text: "pub fn saved() {}\n".into(),
    })
    .unwrap();
    let documents = crate::retrieval::ts_v2::documents(&analysis).unwrap();
    let plan = WindowPlan {
        inputs: Arc::new(documents.iter().map(|d| d.text.clone()).collect()),
        documents: Arc::new((0..documents.len()).map(|i| vec![i]).collect()),
    };
    let vectors = vec![vec![0.5; DIMENSION]; documents.len()];
    let budget =
        crate::retrieval::split::TokenBudget::new(crate::test_support::tokenizer(512)).unwrap();
    let policy = super::super::policy::document_policy(&budget);
    (analysis, documents, plan, vectors, policy)
}

#[test]
fn out_of_order_stages_are_durable_but_cannot_publish_until_complete() {
    let dir = tempfile::tempdir().unwrap();
    let (analysis, documents, plan, vectors, policy) = fixture();
    let hash = super::super::processing::source_hash(&analysis.source.text);
    let key = Key {
        ordinal: 0,
        path: "a.rs",
        source_hash: &hash,
        policy: &policy,
    };
    let live_path = dir.path().join("index.db");
    let mut live = super::super::open(&live_path).unwrap().connection;
    super::super::policy::configure(&mut live, &policy).unwrap();
    let mut store = Store::open(&dir.path().join("staging.db"), &Profiler::default()).unwrap();
    for stage in [
        Stage::Vectors(&vectors),
        Stage::Windows(&documents, &plan),
        Stage::Source(&analysis),
    ] {
        store.record(&key, stage).unwrap();
        assert!(
            store
                .validate_complete(&key, &analysis, &documents, &plan, &vectors)
                .is_err()
        );
        let reader = super::super::open_read_only(&live_path).unwrap();
        assert!(
            super::super::analysis::load(&reader, "a.rs")
                .unwrap()
                .is_none()
        );
        let durable = Connection::open(dir.path().join("staging.db")).unwrap();
        assert_eq!(
            durable
                .query_row("SELECT count(*) FROM work", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
    store.record(&key, Stage::Discovered).unwrap();
    store
        .validate_complete(&key, &analysis, &documents, &plan, &vectors)
        .unwrap();
    super::super::documents::publish(
        &mut live,
        &analysis,
        super::super::documents::Batch {
            documents: &documents,
            vectors: &vectors,
            policy: &policy,
        },
    )
    .unwrap();
    store.remove(&key).unwrap();
    assert_eq!(
        store
            .connection
            .query_row("SELECT count(*) FROM source_stages", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        super::super::analysis::load(&live, "a.rs")
            .unwrap()
            .unwrap(),
        analysis
    );
    store.finish().unwrap();
}

#[test]
fn conflicting_generations_duplicates_and_missing_mappings_are_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let (analysis, documents, plan, vectors, policy) = fixture();
    let hash = super::super::processing::source_hash(&analysis.source.text);
    let key = Key {
        ordinal: 0,
        path: "a.rs",
        source_hash: &hash,
        policy: &policy,
    };
    let mut store = Store::open(&dir.path().join("staging.db"), &Profiler::default()).unwrap();
    store.record(&key, Stage::Discovered).unwrap();
    store.record(&key, Stage::Vectors(&vectors)).unwrap();
    store.record(&key, Stage::Vectors(&vectors)).unwrap();
    let mut conflicting = vectors.clone();
    conflicting[0][0] = 0.25;
    assert!(store.record(&key, Stage::Vectors(&conflicting)).is_err());
    let stale = Key {
        source_hash: "another generation",
        ..key
    };
    assert!(store.record(&stale, Stage::Vectors(&vectors)).is_err());
    let bad = WindowPlan {
        inputs: plan.inputs.clone(),
        documents: Arc::new(vec![vec![usize::MAX]; documents.len()]),
    };
    assert!(
        store
            .record(&key, Stage::Windows(&documents, &bad))
            .is_err()
    );
    assert!(
        store
            .validate_complete(&key, &analysis, &documents, &plan, &vectors)
            .is_err()
    );
    store.record(&key, Stage::Source(&analysis)).unwrap();
    store
        .record(&key, Stage::Windows(&documents, &plan))
        .unwrap();
    store
        .validate_complete(&key, &analysis, &documents, &plan, &vectors)
        .unwrap();
    store.finish().unwrap();
}

#[test]
fn abandoned_stages_are_discarded_while_committed_files_remain_reusable() {
    for publish in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let (analysis, documents, plan, vectors, policy) = fixture();
        let hash = super::super::processing::source_hash(&analysis.source.text);
        let key = Key {
            ordinal: 0,
            path: "a.rs",
            source_hash: &hash,
            policy: &policy,
        };
        let mut live = super::super::open(&dir.path().join("index.db"))
            .unwrap()
            .connection;
        super::super::policy::configure(&mut live, &policy).unwrap();
        let path = dir.path().join("staging.db");
        let mut store = Store::open(&path, &Profiler::default()).unwrap();
        for stage in [
            Stage::Discovered,
            Stage::Source(&analysis),
            Stage::Windows(&documents, &plan),
            Stage::Vectors(&vectors),
        ] {
            store.record(&key, stage).unwrap();
        }
        if publish {
            super::super::documents::publish(
                &mut live,
                &analysis,
                super::super::documents::Batch {
                    documents: &documents,
                    vectors: &vectors,
                    policy: &policy,
                },
            )
            .unwrap();
        }
        // Simulate interruption after a durable stage or after live commit but
        // before stage cleanup. Closing SQLite does not erase committed rows.
        drop(store);
        let profile = Profiler::enabled(crate::embedding::model_identity());
        let store = Store::open(&path, &profile).unwrap();
        assert_eq!(
            store
                .connection
                .query_row("SELECT count(*) FROM work", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            super::super::processing::reusable(&live, &analysis.source, &policy).unwrap(),
            publish
        );
        store.finish().unwrap();
        assert_eq!(
            profile.finish(None).unwrap().counters["staging_abandoned_files"],
            1
        );
    }
}

#[test]
fn failed_publication_rolls_back_the_entire_replacement() {
    let dir = tempfile::tempdir().unwrap();
    let (old, documents, _, vectors, policy) = fixture();
    let path = dir.path().join("index.db");
    let mut live = super::super::open(&path).unwrap().connection;
    super::super::documents::publish(
        &mut live,
        &old,
        super::super::documents::Batch {
            documents: &documents,
            vectors: &vectors,
            policy: &policy,
        },
    )
    .unwrap();
    let replacement = crate::analysis::extract(crate::source::SourceFile {
        path: "a.rs".into(),
        text: "pub fn replacement() {}\n".into(),
    })
    .unwrap();
    let documents = crate::retrieval::ts_v2::documents(&replacement).unwrap();
    let vectors = vec![vec![0.5; DIMENSION]; documents.len()];
    live.execute_batch("CREATE TRIGGER reject_publication BEFORE INSERT ON retrieval_documents BEGIN SELECT RAISE(FAIL, 'publication failed'); END;").unwrap();
    assert!(
        super::super::documents::publish(
            &mut live,
            &replacement,
            super::super::documents::Batch {
                documents: &documents,
                vectors: &vectors,
                policy: &policy
            }
        )
        .is_err()
    );
    live.execute_batch("DROP TRIGGER reject_publication")
        .unwrap();
    let reader = super::super::open_read_only(&path).unwrap();
    assert_eq!(
        super::super::analysis::load(&reader, "a.rs")
            .unwrap()
            .unwrap(),
        old
    );
    assert!(super::super::processing::reusable(&reader, &old.source, &policy).unwrap());
    super::super::documents::publish(
        &mut live,
        &replacement,
        super::super::documents::Batch {
            documents: &documents,
            vectors: &vectors,
            policy: &policy,
        },
    )
    .unwrap();
    assert_eq!(
        super::super::analysis::load(&reader, "a.rs")
            .unwrap()
            .unwrap(),
        replacement
    );
}

#[test]
fn interruption_at_each_stage_keeps_old_search_and_snapshot_results() {
    for stop in 1..=4 {
        let dir = tempfile::tempdir().unwrap();
        let (old, old_documents, _, old_vectors, policy) = fixture();
        let live_path = dir.path().join("index.db");
        let mut live = super::super::open(&live_path).unwrap().connection;
        super::super::documents::publish(
            &mut live,
            &old,
            super::super::documents::Batch {
                documents: &old_documents,
                vectors: &old_vectors,
                policy: &policy,
            },
        )
        .unwrap();
        let next = crate::analysis::extract(crate::source::SourceFile {
            path: "a.rs".into(),
            text: "pub fn unpublished() {}\n".into(),
        })
        .unwrap();
        let documents = crate::retrieval::ts_v2::documents(&next).unwrap();
        let plan = WindowPlan {
            inputs: Arc::new(documents.iter().map(|d| d.text.clone()).collect()),
            documents: Arc::new((0..documents.len()).map(|i| vec![i]).collect()),
        };
        let vectors = vec![vec![0.25; DIMENSION]; documents.len()];
        let hash = super::super::processing::source_hash(&next.source.text);
        let key = Key {
            ordinal: 0,
            path: "a.rs",
            source_hash: &hash,
            policy: &policy,
        };
        let path = dir.path().join("staging.db");
        let mut store = Store::open(&path, &Profiler::default()).unwrap();
        for stage in [
            Stage::Discovered,
            Stage::Source(&next),
            Stage::Windows(&documents, &plan),
            Stage::Vectors(&vectors),
        ]
        .into_iter()
        .take(stop)
        {
            store.record(&key, stage).unwrap();
        }
        drop(store);
        let reader = super::super::open_read_only(&live_path).unwrap();
        assert_eq!(
            super::super::analysis::load(&reader, "a.rs")
                .unwrap()
                .unwrap(),
            old
        );
        assert!(
            super::super::lexical::candidates(&reader, "unpublished", 20)
                .unwrap()
                .is_empty()
        );
        assert!(
            !super::super::lexical::candidates(&reader, "saved", 20)
                .unwrap()
                .is_empty()
        );
        assert!(super::super::processing::reusable(&reader, &old.source, &policy).unwrap());
        assert!(!super::super::processing::reusable(&reader, &next.source, &policy).unwrap());
        let store = Store::open(&path, &Profiler::default()).unwrap();
        assert_eq!(
            store
                .connection
                .query_row("SELECT count(*) FROM work", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
        store.finish().unwrap();
    }
}

#[test]
fn stage_write_failure_never_commits_a_completion_record() {
    let dir = tempfile::tempdir().unwrap();
    let (analysis, documents, plan, vectors, policy) = fixture();
    let hash = super::super::processing::source_hash(&analysis.source.text);
    let key = Key {
        ordinal: 0,
        path: "a.rs",
        source_hash: &hash,
        policy: &policy,
    };
    let mut store = Store::open(&dir.path().join("staging.db"), &Profiler::default()).unwrap();
    store.record(&key, Stage::Discovered).unwrap();
    store.connection.execute_batch("CREATE TRIGGER fail_stage AFTER INSERT ON source_stages BEGIN SELECT RAISE(ABORT, 'stage write failed'); END;").unwrap();
    assert!(store.record(&key, Stage::Source(&analysis)).is_err());
    store
        .connection
        .execute_batch("DROP TRIGGER fail_stage")
        .unwrap();
    assert_eq!(
        store
            .connection
            .query_row("SELECT count(*) FROM source_stages", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert!(
        store
            .validate_complete(&key, &analysis, &documents, &plan, &vectors)
            .is_err()
    );
    store.finish().unwrap();
}

#[test]
fn recovery_rejects_corrupt_payload_and_mismatched_identity() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join(".mimirs")).unwrap();
    let (analysis, documents, plan, vectors, policy) = fixture();
    let hash = super::super::processing::source_hash(&analysis.source.text);
    let key = Key {
        ordinal: 0,
        path: "a.rs",
        source_hash: &hash,
        policy: &policy,
    };
    let mut store = Store::open_for(
        &dir.path().join(".mimirs/staging.db"),
        &Profiler::default(),
        true,
    )
    .unwrap();
    for stage in [
        Stage::Discovered,
        Stage::Source(&analysis),
        Stage::Windows(&documents, &plan),
        Stage::Vectors(&vectors),
    ] {
        store.record(&key, stage).unwrap();
    }
    assert!(recover(dir.path(), "a.rs", &hash, &policy).is_some());
    assert!(recover(dir.path(), "b.rs", &hash, &policy).is_none());
    assert!(recover(dir.path(), "a.rs", &"0".repeat(64), &policy).is_none());
    store
        .connection
        .execute(
            "UPDATE vector_stages SET payload=zeroblob(length(payload))",
            [],
        )
        .unwrap();
    assert!(recover(dir.path(), "a.rs", &hash, &policy).is_none());
}
