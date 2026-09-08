use std::cell::RefCell;
use std::fs;
use std::rc::Rc;

use rusqlite::Connection;
use tempfile::TempDir;

use super::*;
use crate::embedding::{Backend, DIMENSION, Embedder};
use crate::source::SourceFile;

struct FixedBackend {
    calls: Rc<RefCell<Vec<Vec<String>>>>,
    output: Vec<Vec<f32>>,
    fail: bool,
}

impl Backend for FixedBackend {
    fn tokenizer(&mut self) -> anyhow::Result<tokenizers::Tokenizer> {
        Ok(crate::test_support::tokenizer(512))
    }
    fn embed(&mut self, texts: &[String]) -> anyhow::Result<Vec<Vec<f32>>> {
        self.calls.borrow_mut().push(texts.to_vec());
        ensure!(!self.fail, "inference failed");
        Ok(self.output.clone())
    }
}

fn vector(x: f32, y: f32) -> Vec<f32> {
    let mut vector = vec![0.0; DIMENSION];
    vector[0] = x;
    vector[1] = y;
    vector
}

fn project() -> (TempDir, Connection) {
    let dir = TempDir::new().unwrap();
    fs::create_dir(dir.path().join(".mimirs")).unwrap();
    let connection = storage::open(&dir.path().join(".mimirs/index.db"))
        .unwrap()
        .connection;
    fs::write(
        dir.path().join(".mimirs/config.toml"),
        crate::config::Config::default().to_toml().unwrap(),
    )
    .unwrap();
    (dir, connection)
}

fn save(connection: &mut Connection, path: &str, text: &str, vectors: &[Vec<f32>]) {
    let source = SourceFile {
        path: path.to_owned(),
        text: text.to_owned(),
    };
    let analysis = crate::analysis::extract(source).unwrap();
    let budget =
        crate::retrieval::split::TokenBudget::new(crate::test_support::tokenizer(512)).unwrap();
    let docs = crate::retrieval::ts_v2::documents(&analysis).unwrap();
    let policy = storage::policy::document_policy(&budget);
    storage::documents::save(
        connection,
        &analysis,
        storage::documents::Batch {
            documents: &docs,
            vectors,
            policy: &policy,
        },
    )
    .unwrap();
}

fn execute(
    root: &Path,
    query: &str,
    limit: usize,
    factory: impl FnOnce() -> anyhow::Result<Embedder>,
) -> (anyhow::Result<()>, String) {
    let mut output = Vec::new();
    let result = run_at(root, query, limit, factory, &mut output, &|| {
        Duration::from_millis(140)
    });
    (result, String::from_utf8(output).unwrap())
}

fn unused_embedder() -> anyhow::Result<Embedder> {
    panic!("must not create an embedder")
}

fn fixed() -> FixedBackend {
    FixedBackend {
        calls: Rc::default(),
        output: vec![vector(1.0, 0.0)],
        fail: false,
    }
}

#[test]
fn search_golden_preserves_stored_text_and_ignores_source_and_config_changes() {
    let (dir, mut connection) = project();
    save(
        &mut connection,
        "z.rs",
        "fn café() {}\nfn other() {}",
        &[vector(1.0, 0.0), vector(-1.0, 0.0)],
    );
    save(&mut connection, "a.rs", "same score", &[vector(1.0, 0.0)]);
    fs::write(dir.path().join("a.rs"), "changed source").unwrap();
    fs::write(dir.path().join("z.rs"), "deleted source").unwrap();
    fs::remove_file(dir.path().join("z.rs")).unwrap();
    fs::write(
        dir.path().join(".mimirs/config.toml"),
        "include = [\"**/*.none\"]",
    )
    .unwrap();
    drop(connection);
    let before = fs::read(dir.path().join(".mimirs/index.db")).unwrap();
    let backend = fixed();
    let calls = backend.calls.clone();
    let (result, output) = execute(dir.path(), "  entry point  ", 2, || {
        Ok(Embedder::new(backend))
    });
    result.unwrap();
    assert_eq!(output, include_str!("../../goldens/search/results.txt"));
    assert_eq!(*calls.borrow(), [vec!["  entry point  ".to_owned()]]);
    assert_eq!(
        fs::read(dir.path().join(".mimirs/index.db")).unwrap(),
        before
    );
}

#[test]
fn empty_indexes_skip_embedder_creation() {
    let (dir, mut connection) = project();
    for state in 0..3 {
        match state {
            1 => save(&mut connection, "blank.rs", " \n\t", &[]),
            2 => storage::reconcile(&mut connection, &[]).unwrap(),
            _ => {}
        }
        for limit in [1, 100] {
            let (result, output) = execute(dir.path(), "query", limit, unused_embedder);
            result.unwrap();
            assert_eq!(output, include_str!("../../goldens/search/empty.txt"));
        }
    }
}

#[test]
fn invalid_arguments_fail_before_database_access_even_with_an_empty_index() {
    let missing = TempDir::new().unwrap();
    let (empty, _) = project();
    for root in [missing.path(), empty.path()] {
        for (query, limit, message) in [
            ("", 5, "query must not be blank"),
            (" \t\n\u{2003}", 5, "query must not be blank"),
            ("query", 0, "limit must be between 1 and 100"),
            ("query", 101, "limit must be between 1 and 100"),
            ("query", usize::MAX, "limit must be between 1 and 100"),
        ] {
            let (result, output) = execute(root, query, limit, unused_embedder);
            assert_eq!(result.unwrap_err().to_string(), message);
            assert!(output.is_empty());
        }
    }
    assert!(!missing.path().join(".mimirs").exists());
}

#[test]
fn bad_databases_fail_before_embedding_and_remain_unchanged() {
    for case in [
        "missing", "old", "newer", "unknown", "foreign", "damaged", "schema",
    ] {
        let (dir, connection) = project();
        let path = dir.path().join(".mimirs/index.db");
        let message = match case {
            "missing" => "run mimirs init or mimirs index",
            "old" => "run mimirs init or mimirs index",
            "newer" => "newer than supported",
            "unknown" => "unknown database schema version",
            "foreign" | "schema" => "unknown or damaged database schema",
            _ => "not a database",
        };
        match case {
            "newer" => connection.pragma_update(None, "user_version", 99).unwrap(),
            "unknown" => connection.pragma_update(None, "user_version", 0).unwrap(),
            "schema" => connection
                .execute_batch("DROP TABLE index_metadata")
                .unwrap(),
            _ => {}
        }
        drop(connection);
        if ["missing", "old", "foreign", "damaged"].contains(&case) {
            fs::remove_file(&path).unwrap();
        }
        if case == "old" {
            let old = Connection::open(&path).unwrap();
            old.execute_batch(include_str!("../../../src/storage/schema_v1.sql"))
                .unwrap();
            old.pragma_update(None, "user_version", 1).unwrap();
        }
        if case == "foreign" {
            let foreign = Connection::open(&path).unwrap();
            foreign
                .execute_batch("CREATE TABLE unrelated(x); PRAGMA user_version = 1")
                .unwrap();
        }
        if case == "damaged" {
            fs::write(&path, b"not a database").unwrap();
        }
        let before = fs::read(&path).ok();
        let (result, output) = execute(dir.path(), "query", 5, unused_embedder);
        let error = format!("{:#}", result.unwrap_err());
        assert!(error.contains(message), "{case}: {error}");
        assert!(error.contains("index.db"));
        assert!(output.is_empty());
        assert_eq!(fs::read(&path).ok(), before, "{case}");
    }
}

#[test]
fn unrelated_content_damage_is_deferred_to_the_index_audit() {
    for mutation in [
        "PRAGMA foreign_keys = OFF; INSERT INTO source_snapshots VALUES (99, 'old', '')",
        "UPDATE retrieval_processing SET policy = 'different' WHERE file_id = (SELECT id FROM files WHERE path = 'blank.rs')",
    ] {
        let (dir, mut connection) = project();
        save(
            &mut connection,
            "a.rs",
            "fn recoverArchive() {}\n",
            &[vector(1.0, 0.0)],
        );
        save(&mut connection, "blank.rs", "", &[]);
        connection.execute_batch(mutation).unwrap();
        assert!(storage::audit(&connection).is_err(), "{mutation}");
        drop(connection);
        let path = dir.path().join(".mimirs/index.db");
        let before = fs::read(&path).unwrap();
        let (result, output) = execute(dir.path(), "recoverArchive", 1, || {
            Ok(Embedder::new(fixed()))
        });
        result.unwrap();
        assert!(output.contains("location: a.rs:1"));
        assert_eq!(fs::read(&path).unwrap(), before);
    }
}

#[test]
fn damaged_returned_evidence_still_fails_without_output_or_writes() {
    for mutation in [
        "UPDATE retrieval_processing SET policy = 'different'",
        "UPDATE retrieval_processing SET document_count = document_count + 1",
        "UPDATE retrieval_documents SET policy = 'different'",
        "UPDATE retrieval_documents SET text = 'tampered'",
        "UPDATE retrieval_documents SET evidence = '[]'",
        "PRAGMA foreign_keys = OFF; DELETE FROM source_snapshots",
    ] {
        let (dir, mut connection) = project();
        save(
            &mut connection,
            "a.rs",
            "fn recoverArchive() {}\n",
            &[vector(1.0, 0.0)],
        );
        connection.execute_batch(mutation).unwrap();
        drop(connection);
        let path = dir.path().join(".mimirs/index.db");
        let before = fs::read(&path).unwrap();
        let (result, output) = execute(dir.path(), "recoverArchive", 1, || {
            Ok(Embedder::new(fixed()))
        });
        assert!(result.is_err(), "{mutation}");
        assert!(output.is_empty(), "{mutation}");
        assert_eq!(fs::read(&path).unwrap(), before);
    }
}

#[test]
fn bad_model_metadata_fails_before_empty_check_or_embedding() {
    for populated in [false, true] {
        for mutation in [
            "DELETE FROM index_metadata WHERE key = 'embedding_model'",
            "DELETE FROM index_metadata WHERE key = 'embedding_dimension'",
            "UPDATE index_metadata SET value = 'different' WHERE key = 'embedding_model'",
            "UPDATE index_metadata SET value = '383' WHERE key = 'embedding_dimension'",
            "UPDATE index_metadata SET value = 'invalid' WHERE key = 'embedding_dimension'",
            "DELETE FROM index_metadata",
        ] {
            let (dir, mut connection) = project();
            if populated {
                save(&mut connection, "a.rs", "line", &[vector(1.0, 0.0)]);
            } else {
                save(&mut connection, "a.rs", "", &[]);
            }
            connection.execute_batch(mutation).unwrap();
            drop(connection);
            let path = dir.path().join(".mimirs/index.db");
            let before = fs::read(&path).unwrap();
            let (result, output) = execute(dir.path(), "query", 5, unused_embedder);
            assert!(result.is_err(), "{mutation}");
            assert!(output.is_empty());
            assert_eq!(fs::read(&path).unwrap(), before);
        }
    }
}

#[test]
fn embedding_failures_leave_stdout_empty_and_preserve_the_index() {
    let (dir, mut connection) = project();
    save(&mut connection, "a.rs", "line", &[vector(1.0, 0.0)]);
    drop(connection);
    let path = dir.path().join(".mimirs/index.db");
    let before = fs::read(&path).unwrap();
    for output in [
        vec![],
        vec![vector(1.0, 0.0); 2],
        vec![vec![0.0; 383]],
        vec![vector(f32::NAN, 0.0)],
    ] {
        let backend = FixedBackend { output, ..fixed() };
        let (result, stdout) = execute(dir.path(), "query", 5, || Ok(Embedder::new(backend)));
        assert!(result.is_err());
        assert!(stdout.is_empty());
    }
    let backend = FixedBackend {
        fail: true,
        ..fixed()
    };
    let (result, stdout) = execute(dir.path(), "query", 5, || Ok(Embedder::new(backend)));
    assert_eq!(
        format!("{:#}\n", result.unwrap_err()),
        include_str!("../../goldens/search/inference_failure.txt")
    );
    assert!(stdout.is_empty());
    let (result, stdout) = execute(dir.path(), "query", 5, || {
        anyhow::bail!("cannot initialize model")
    });
    assert!(result.is_err());
    assert!(stdout.is_empty());
    assert_eq!(fs::read(path).unwrap(), before);
}

/// Uses the per-user model cache and downloads MiniLM if needed. Run with:
/// `cargo test real_minilm_search_retrieves_indexed_source -- --ignored --nocapture`
#[test]
#[ignore = "loads or downloads the MiniLM model"]
fn real_minilm_search_retrieves_indexed_source() {
    let (dir, mut connection) = project();
    let source = SourceFile {
        path: "src/lib.rs".to_owned(),
        text: "// Read the configuration file from disk.\nfn read_config(path: &str) -> std::io::Result<String> { std::fs::read_to_string(path) }\n// Sort numbers in ascending order.\nfn sort_numbers(values: &mut [i32]) { values.sort(); }".to_owned(),
    };
    let analysis = crate::analysis::extract(source).unwrap();
    let mut embedder = embedding::production().unwrap();
    let budget = embedder.token_budget().unwrap();
    let policy = storage::policy::document_policy(&budget);
    let docs = crate::retrieval::ts_v2::documents(&analysis).unwrap();
    let texts: Vec<_> = docs.iter().map(|d| d.text.clone()).collect();
    let vectors = embedder.embed_ts_documents(&texts, |_, _| Ok(())).unwrap();
    storage::documents::save(
        &mut connection,
        &analysis,
        storage::documents::Batch {
            documents: &docs,
            vectors: &vectors,
            policy: &policy,
        },
    )
    .unwrap();
    drop(connection);
    let (result, output) = execute(dir.path(), "read configuration from a file", 1, || {
        Ok(embedder)
    });
    result.unwrap();
    // The selected source chunk includes its attached comment.
    assert!(output.contains("location: src/lib.rs:1-2\n"), "{output}");
    assert!(output.contains("source: indexed snapshot") && output.contains("evidence: Source"));
    assert!(
        output.contains("fn read_config(path: &str) -> std::io::Result<String> { std::fs::read_to_string(path) }"),
        "{output}"
    );
}

#[test]
fn source_search_forwards_distilled_query_and_reads_deleted_snapshot() {
    let (dir, mut connection) = project();
    let budget =
        crate::retrieval::split::TokenBudget::new(crate::test_support::tokenizer(512)).unwrap();
    let policy = storage::policy::document_policy(&budget);
    storage::policy::configure(&mut connection, &policy).unwrap();
    let analysis = crate::analysis::extract(SourceFile {
        path: "deleted.rs".into(),
        text: "/// Expire sessions.\nfn expire_sessions() {}".into(),
    })
    .unwrap();
    let docs = crate::retrieval::ts_v2::documents(&analysis).unwrap();
    storage::documents::save(
        &mut connection,
        &analysis,
        storage::documents::Batch {
            documents: &docs,
            vectors: &vec![vector(1.0, 0.0); docs.len()],
            policy: &policy,
        },
    )
    .unwrap();
    drop(connection);
    let backend = fixed();
    let calls = backend.calls.clone();
    let query = "  expire_sessions after expiry time  ";
    let (result, output) = execute(dir.path(), query, 5, || Ok(Embedder::new(backend)));
    result.unwrap();
    assert_eq!(*calls.borrow(), [vec![query.to_owned()]]);
    assert!(output.contains("location: deleted.rs:1-2"));
    assert!(output.contains("source: indexed snapshot"));
    assert!(output.contains("/// Expire sessions."));
    assert!(output.contains("evidence: Source"));
}

#[test]
fn multiple_matching_chunks_show_later_answer_from_deleted_snapshot() {
    let (dir, mut connection) = project();
    let text = format!(
        "fn answer() {{\n{}}}\n",
        (0..600)
            .map(|i| format!("    let value_{i} = compute({i});\n"))
            .collect::<String>()
    );
    let analysis = crate::analysis::extract(SourceFile {
        path: "deleted.rs".into(),
        text,
    })
    .unwrap();
    let budget =
        crate::retrieval::split::TokenBudget::new(crate::test_support::tokenizer(512)).unwrap();
    let docs = crate::retrieval::ts_v2::documents(&analysis).unwrap();
    assert!(docs.len() > 3);
    let policy = storage::policy::document_policy(&budget);
    let vectors = (0..docs.len())
        .map(|i| vector(1.0, i as f32))
        .collect::<Vec<_>>();
    storage::documents::save(
        &mut connection,
        &analysis,
        storage::documents::Batch {
            documents: &docs,
            vectors: &vectors,
            policy: &policy,
        },
    )
    .unwrap();
    drop(connection);
    let (result, output) = execute(dir.path(), "later answer", 1, || Ok(Embedder::new(fixed())));
    result.unwrap();
    assert!(!output.contains("omitted_matching_candidates:"));
    for doc in &docs {
        for e in &doc.evidence {
            assert!(output.contains(&format!(
                "evidence: Source bytes {}..{} lines {}..{}",
                e.span.start, e.span.end, e.span.line_start, e.span.line_end
            )));
            let raw = &analysis.source.text[e.span.start..e.span.end];
            assert!(output.contains(raw));
        }
    }
    assert!(output.contains("value_599"));
}

#[test]
fn lexical_results_survive_missing_vectors_and_use_current_generated_rules() {
    let (dir, mut connection) = project();
    for path in ["a.rs", "b.rs"] {
        save(
            &mut connection,
            path,
            "fn recoverArchive() {}\n",
            &[vector(1.0, 0.0)],
        );
    }
    connection
        .execute("DELETE FROM document_embeddings", [])
        .unwrap();
    let (result, output) = execute(dir.path(), "recoverArchive", 1, || {
        Ok(Embedder::new(fixed()))
    });
    result.unwrap();
    assert!(output.contains("location: a.rs:1"));
    assert!(!output.contains("similarity:"));
    let config = crate::config::Config {
        generated: vec!["a.rs".into()],
        ..Default::default()
    };
    fs::write(
        dir.path().join(".mimirs/config.toml"),
        config.to_toml().unwrap(),
    )
    .unwrap();
    let (result, output) = execute(dir.path(), "recoverArchive", 1, || {
        Ok(Embedder::new(fixed()))
    });
    result.unwrap();
    assert!(output.contains("location: b.rs:1"));
}

#[test]
fn documentation_is_a_separate_segment_with_exact_reference_evidence() {
    let (dir, mut connection) = project();
    save(
        &mut connection,
        "docs/guide.md",
        "# Recovery\nRead [implementation](../src/archive.rs).\n",
        &[vector(1.0, 0.0)],
    );
    save(
        &mut connection,
        "src/archive.rs",
        "fn recoverArchive() {}\n",
        &[vector(0.0, 1.0)],
    );
    let (result, output) = execute(dir.path(), "Recovery", 1, || Ok(Embedder::new(fixed())));
    result.unwrap();
    assert!(output.starts_with("results: 1\n"));
    let (source, docs) = output.split_once("\ndocumentation: 1\n").unwrap();
    assert!(source.contains("location: src/archive.rs:1"));
    assert!(!source.contains("location: docs/guide.md"));
    assert!(docs.contains("location: docs/guide.md:1-2"));
    assert!(docs.contains("reference: ") && docs.contains("../src/archive.rs"));
}
