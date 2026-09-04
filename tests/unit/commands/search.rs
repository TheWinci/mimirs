use std::cell::RefCell;
use std::fs;
use std::rc::Rc;

use rusqlite::Connection;
use tempfile::TempDir;

use super::*;
use crate::embedding::{Backend, DIMENSION, Embedder, MODEL_NAME};
use crate::source::SourceFile;

struct FixedBackend {
    calls: Rc<RefCell<Vec<Vec<String>>>>,
    output: Vec<Vec<f32>>,
    fail: bool,
}

impl Backend for FixedBackend {
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
    (dir, connection)
}

fn save(connection: &mut Connection, path: &str, text: &str, vectors: &[Vec<f32>]) {
    let source = SourceFile {
        path: path.to_owned(),
        text: text.to_owned(),
    };
    let chunks = crate::chunk::of(&source);
    let windows = crate::window::of(&chunks[0]);
    storage::save_file(
        connection, &source, &chunks, &windows, vectors, MODEL_NAME, DIMENSION,
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
        "  café();  \n\nother",
        &[vector(1.0, 0.0), vector(-1.0, 0.0)],
    );
    save(&mut connection, "a.rs", "same score", &[vector(1.0, 0.0)]);
    fs::write(dir.path().join("a.rs"), "changed source").unwrap();
    fs::write(dir.path().join("z.rs"), "deleted source").unwrap();
    fs::remove_file(dir.path().join("z.rs")).unwrap();
    fs::write(dir.path().join(".mimirs/config.toml"), "not valid toml").unwrap();
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
            2 => storage::reconcile(&mut connection, &[], MODEL_NAME, DIMENSION).unwrap(),
            _ => {}
        }
        for limit in [1, 4096] {
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
            ("query", 0, "limit must be between 1 and 4096"),
            ("query", 4097, "limit must be between 1 and 4096"),
            ("query", usize::MAX, "limit must be between 1 and 4096"),
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
        "missing",
        "old",
        "newer",
        "unknown",
        "foreign",
        "damaged",
        "schema",
        "foreign_key",
    ] {
        let (dir, connection) = project();
        let path = dir.path().join(".mimirs/index.db");
        let message = match case {
            "missing" => "run mimirs init or mimirs index",
            "old" => "run mimirs init or mimirs index",
            "newer" => "newer than supported",
            "unknown" => "unknown database schema version",
            "foreign" | "schema" => "unknown or damaged database schema",
            "foreign_key" => "broken foreign keys",
            _ => "not a database",
        };
        match case {
            "newer" => connection.pragma_update(None, "user_version", 99).unwrap(),
            "unknown" => connection.pragma_update(None, "user_version", 0).unwrap(),
            "schema" => connection.execute_batch("DROP TABLE index_metadata").unwrap(),
            "foreign_key" => connection.execute_batch("PRAGMA foreign_keys = OFF; INSERT INTO chunks VALUES (1, 99, 0, '', 0, 0, 1, 1)").unwrap(),
            _ => {},
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
/// `cargo test real_minilm_search_retrieves_rust_window -- --ignored --nocapture`
#[test]
#[ignore = "loads or downloads the MiniLM model"]
fn real_minilm_search_retrieves_rust_window() {
    let (dir, mut connection) = project();
    let source = SourceFile {
        path: "src/lib.rs".to_owned(),
        text: "// Read the configuration file from disk.\nfn read_config(path: &str) -> std::io::Result<String> { std::fs::read_to_string(path) }\n// Sort numbers in ascending order.\nfn sort_numbers(values: &mut [i32]) { values.sort(); }".to_owned(),
    };
    let chunks = crate::chunk::of(&source);
    let windows = crate::window::of(&chunks[0]);
    let texts = windows
        .iter()
        .map(|window| window.text.clone())
        .collect::<Vec<_>>();
    let mut embedder = embedding::production().unwrap();
    let vectors = embedder.embed_documents(&texts, |_, _| {}).unwrap();
    storage::save_file(
        &mut connection,
        &source,
        &chunks,
        &windows,
        &vectors,
        MODEL_NAME,
        DIMENSION,
    )
    .unwrap();
    drop(connection);
    let (result, output) = execute(dir.path(), "read configuration from a file", 1, || {
        Ok(embedder)
    });
    result.unwrap();
    assert!(output.contains("location: src/lib.rs:1-4"), "{output}");
    assert!(
        output.contains("text: // Read the configuration file from disk."),
        "{output}"
    );
}
