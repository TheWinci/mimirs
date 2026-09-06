use super::*;
use crate::retrieval::{source::documents, split::TokenBudget};

#[test]
fn saves_replace_only_the_requested_file_without_duplicates() {
    let dir = TempDir::new().unwrap();
    let mut db = open(&dir.path().join("index.db")).unwrap().connection;
    save_text(&mut db, "a.rs", "fn old() {}\nfn gone() {}").unwrap();
    save_text(&mut db, "b.rs", "fn keep() {}").unwrap();
    let b = analysis::load(&db, "b.rs").unwrap().unwrap();
    save_text(&mut db, "a.rs", "fn new() {}").unwrap();
    assert_eq!(count(&db, "files"), 2);
    assert_eq!(count(&db, "retrieval_documents"), 2);
    assert_eq!(count(&db, "document_embeddings"), 2);
    assert_eq!(analysis::load(&db, "b.rs").unwrap().unwrap(), b);
    assert_eq!(
        analysis::load(&db, "a.rs").unwrap().unwrap().source.text,
        "fn new() {}"
    );
    policy::read(&db).unwrap();
}

#[test]
fn empty_files_store_snapshots_without_vectors() {
    let dir = TempDir::new().unwrap();
    let mut db = open(&dir.path().join("index.db")).unwrap().connection;
    for text in ["fn old() {}", "", " \r\n"] {
        save_text(&mut db, "a.rs", text).unwrap();
        assert_eq!(
            analysis::load(&db, "a.rs").unwrap().unwrap().source.text,
            text
        );
        assert!(validate_model(&db).unwrap());
        assert_eq!(
            count(&db, "document_embeddings"),
            i64::from(!text.trim().is_empty())
        );
        policy::read(&db).unwrap();
    }
}

#[test]
fn invalid_inputs_leave_both_new_and_populated_indexes_unchanged() {
    for populated in [false, true] {
        let dir = TempDir::new().unwrap();
        let mut db = open(&dir.path().join("index.db")).unwrap().connection;
        if populated {
            save_text(&mut db, "a.rs", "fn old() {}").unwrap();
        }
        let before = snapshot(&db);
        let analysis = crate::analysis::extract(source("a.rs", "fn new() {}")).unwrap();
        let budget = TokenBudget::new(crate::test_support::tokenizer(512)).unwrap();
        let policy = policy::legacy_document_policy(&budget);
        let docs = documents(&analysis, &budget).unwrap();
        for change in 0..9 {
            let mut docs = docs.clone();
            let mut vectors = vec![vector(1.0, 0.0)];
            match change {
                0 => docs[0].owner = Some(999),
                1 => docs[0].evidence[0].span.end = 999,
                2 => docs[0].part = 1,
                3 => vectors.clear(),
                4 => vectors.push(vector(1.0, 0.0)),
                5 => vectors[0].pop().map(|_| ()).unwrap(),
                6 => vectors[0][0] = f32::NAN,
                7 => vectors[0][0] = f32::INFINITY,
                _ => docs[0].text.clear(),
            }
            assert!(
                documents::save(
                    &mut db,
                    &analysis,
                    documents::Batch {
                        documents: &docs,
                        vectors: &vectors,
                        policy: &policy
                    }
                )
                .is_err()
            );
            assert_eq!(snapshot(&db), before, "case {change}");
        }
    }
}

#[test]
fn malformed_metadata_never_overwrites_existing_rows() {
    for mutation in [
        "DELETE FROM index_metadata WHERE key = 'embedding_model'",
        "DELETE FROM index_metadata WHERE key = 'embedding_dimension'",
        "DELETE FROM index_metadata",
        "UPDATE index_metadata SET value = 'other-model' WHERE key = 'embedding_model'",
        "UPDATE index_metadata SET value = '383' WHERE key = 'embedding_dimension'",
        "UPDATE index_metadata SET value = '-384' WHERE key = 'embedding_dimension'",
        "UPDATE index_metadata SET value = 'invalid' WHERE key = 'embedding_dimension'",
    ] {
        let dir = TempDir::new().unwrap();
        let mut connection = open(&dir.path().join("index.db")).unwrap().connection;
        save_text(&mut connection, "a.rs", "old").unwrap();
        connection.execute(mutation, []).unwrap();
        let before = snapshot(&connection);
        assert!(
            save_text(&mut connection, "a.rs", "replacement").is_err(),
            "{mutation}"
        );
        assert_eq!(snapshot(&connection), before, "{mutation}");
    }
    for key in ["embedding_model", "embedding_dimension"] {
        let dir = TempDir::new().unwrap();
        let mut connection = open(&dir.path().join("index.db")).unwrap().connection;
        connection
            .execute("INSERT INTO index_metadata VALUES (?1, 'value')", [key])
            .unwrap();
        let before = snapshot(&connection);
        assert!(save_text(&mut connection, "a.rs", "").is_err());
        assert_eq!(snapshot(&connection), before);
    }
}

#[test]
fn database_failures_roll_back_metadata_deletions_and_partial_inserts() {
    for populated in [false, true] {
        let dir = TempDir::new().unwrap();
        let mut db = open(&dir.path().join("index.db")).unwrap().connection;
        if populated {
            save_text(&mut db, "a.rs", "fn old() {}\nfn keep() {}").unwrap();
        }
        let before = snapshot(&db);
        db.execute_batch("CREATE TRIGGER fail_document BEFORE INSERT ON retrieval_documents WHEN NEW.ordinal=1 BEGIN SELECT RAISE(ABORT, 'forced insert failure'); END;").unwrap();
        let error = save_text(&mut db, "a.rs", "fn new() {}\nfn fails() {}").unwrap_err();
        assert!(format!("{error:#}").contains("forced insert failure"));
        assert_eq!(snapshot(&db), before);
        if populated {
            assert_eq!(nearest(&db, &vector(1.0, 0.0), 10).unwrap().len(), 2);
        }
    }
}
