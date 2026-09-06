use std::cell::RefCell;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::rc::Rc;

use rusqlite::Connection;
use tempfile::TempDir;

use super::*;
use crate::embedding::{Backend, DIMENSION, Embedder};

#[derive(Default)]
struct Calls {
    preparations: usize,
    batches: Vec<Vec<String>>,
}

struct TestBackend {
    calls: Rc<RefCell<Calls>>,
    fail_on: Option<String>,
    prepare: Option<Box<dyn FnMut() -> anyhow::Result<()>>>,
}

impl Backend for TestBackend {
    fn tokenizer(&mut self) -> anyhow::Result<tokenizers::Tokenizer> {
        Ok(crate::test_support::tokenizer(512))
    }
    fn prepare(&mut self) -> anyhow::Result<()> {
        self.calls.borrow_mut().preparations += 1;
        if let Some(prepare) = &mut self.prepare {
            prepare()?;
        }
        Ok(())
    }

    fn embed(&mut self, texts: &[String]) -> anyhow::Result<Vec<Vec<f32>>> {
        self.calls.borrow_mut().batches.push(texts.to_vec());
        if self
            .fail_on
            .as_ref()
            .is_some_and(|fail| texts.contains(fail))
        {
            anyhow::bail!("inference failed");
        }
        Ok(texts
            .iter()
            .map(|text| {
                let mut vector = vec![0.0; DIMENSION];
                vector[0] = text.len() as f32;
                vector[1] = 1.0;
                vector
            })
            .collect())
    }
}

fn backend() -> TestBackend {
    TestBackend {
        calls: Rc::new(RefCell::new(Calls::default())),
        fail_on: None,
        prepare: None,
    }
}

fn project(files: &[(&str, &str)]) -> TempDir {
    let dir = TempDir::new().unwrap();
    fs::create_dir(dir.path().join(".mimirs")).unwrap();
    fs::write(
        dir.path().join(".mimirs/config.toml"),
        Config::default().to_toml().unwrap(),
    )
    .unwrap();
    for (path, text) in files {
        let path = dir.path().join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }
    dir
}

fn run(
    dir: &TempDir,
    backend: TestBackend,
    terminal: bool,
) -> (anyhow::Result<()>, String, String) {
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let result = run_at(
        dir.path(),
        || Ok(Embedder::new(backend)),
        &mut stdout,
        &mut stderr,
        terminal,
        &|| Duration::from_millis(1250),
    );
    let stderr = String::from_utf8(stderr)
        .unwrap()
        .replace(&dir.path().display().to_string(), "ROOT");
    (result, String::from_utf8(stdout).unwrap(), stderr)
}

fn connection(dir: &TempDir) -> Connection {
    // Use storage once to register vec0, then read directly so injected failure
    // triggers do not need to match the normal schema.
    Connection::open(dir.path().join(".mimirs/index.db")).unwrap()
}

fn files(dir: &TempDir) -> Vec<(String, String)> {
    connection(dir).prepare("SELECT f.path, s.source FROM files f JOIN source_snapshots s ON s.file_id=f.id ORDER BY f.path")
        .unwrap().query_map([], |row| Ok((row.get(0)?, row.get(1)?))).unwrap()
        .collect::<rusqlite::Result<_>>().unwrap()
}

fn counts(dir: &TempDir) -> Vec<i64> {
    let db = connection(dir);
    [
        "files",
        "source_snapshots",
        "retrieval_documents",
        "document_embeddings",
        "index_metadata",
    ]
    .iter()
    .map(|table| {
        db.query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .unwrap()
    })
    .collect()
}

#[test]
fn redirected_output_and_stored_relationships_match_the_contract() {
    let dir = project(&[("b.rs", " \n"), ("a.rs", "first\n\n  second  \n")]);
    let model = backend();
    let calls = Rc::clone(&model.calls);
    let (result, stdout, stderr) = run(&dir, model, false);
    result.unwrap();
    assert_eq!(
        stdout,
        "indexed: 2 files\nunchanged: 0 files\nskipped: 0 files\nwalk_errors: 0\ntime: 1.25 seconds\n"
    );
    assert_eq!(stderr, include_str!("../../goldens/index/redirected.txt"));
    assert_eq!(calls.borrow().preparations, 1);
    assert_eq!(
        calls.borrow().batches,
        [vec!["a.rs\nfirst\n\n  second  \n"]]
    );
    assert_eq!(counts(&dir), [2, 2, 1, 1, 3]);
    let db = connection(&dir);
    let (text, vector): (String, Vec<u8>) = db.query_row(
        "SELECT d.text, e.embedding FROM retrieval_documents d JOIN document_embeddings e ON e.document_id=d.id", [],
        |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
    assert_eq!(vector.len(), DIMENSION * 4);
    assert_eq!(
        f32::from_ne_bytes(vector[..4].try_into().unwrap()),
        text.len() as f32
    );
    let snapshot = storage::analysis::load(&db, "a.rs").unwrap().unwrap();
    assert_eq!(snapshot.source.text, "first\n\n  second  \n");
    run(&dir, backend(), false).0.unwrap();
    assert_eq!(counts(&dir), [2, 2, 1, 1, 3]);
}

#[test]
fn batches_update_only_terminal_progress() {
    let text = (0..257)
        .map(|n| format!("fn f{n}() {{}}\n"))
        .collect::<String>();
    for terminal in [false, true] {
        let dir = project(&[("a.rs", &text)]);
        let model = backend();
        let calls = Rc::clone(&model.calls);
        let (result, _, stderr) = run(&dir, model, terminal);
        result.unwrap();
        assert_eq!(
            calls
                .borrow()
                .batches
                .iter()
                .map(Vec::len)
                .collect::<Vec<_>>(),
            [256, 1]
        );
        assert_eq!(stderr.contains("100% (256/257 documents)"), terminal);
        assert_eq!(stderr.contains("\x1b["), terminal);
        assert!(stderr.contains("index_progress: 100% (1/1 files)"));
        if terminal {
            assert!(stderr.ends_with("\x1b[6F\x1b[J"));
        }
    }
}

#[test]
fn read_skips_finish_and_empty_runs_clear_stored_files() {
    let dir = project(&[("a.rs", "old")]);
    run(&dir, backend(), false).0.unwrap();
    fs::write(dir.path().join("a.rs"), [0xff]).unwrap();
    let (result, stdout, stderr) = run(&dir, backend(), false);
    result.unwrap();
    assert_eq!(
        stdout,
        "indexed: 0 files\nunchanged: 0 files\nskipped: 1 files\nwalk_errors: 0\ntime: 1.25 seconds\n"
    );
    assert_eq!(stderr, include_str!("../../goldens/index/read_skip.txt"));
    assert_eq!(counts(&dir), [0, 0, 0, 0, 3]);
    fs::remove_file(dir.path().join("a.rs")).unwrap();
    let model = backend();
    let calls = Rc::clone(&model.calls);
    let (result, stdout, stderr) = run(&dir, model, false);
    result.unwrap();
    assert_eq!(
        stdout,
        "indexed: 0 files\nunchanged: 0 files\nskipped: 0 files\nwalk_errors: 0\ntime: 1.25 seconds\n"
    );
    assert_eq!(stderr, include_str!("../../goldens/index/empty.txt"));
    assert_eq!(calls.borrow().preparations, 1);
    assert!(calls.borrow().batches.is_empty());
    assert_eq!(counts(&dir), [0, 0, 0, 0, 3]);
}

#[test]
fn fresh_empty_index_records_policy_without_model() {
    let dir = project(&[]);
    run(&dir, backend(), false).0.unwrap();
    assert_eq!(counts(&dir), [0, 0, 0, 0, 1]);
}

#[test]
fn cleanup_removes_deleted_excluded_and_unreadable_files_with_vectors() {
    let dir = project(&[
        ("a.rs", "keep"),
        ("b.rs", "delete"),
        ("c.rs", "exclude"),
        ("d.rs", "unreadable"),
    ]);
    run(&dir, backend(), false).0.unwrap();
    fs::remove_file(dir.path().join("b.rs")).unwrap();
    let mut config = Config::default();
    config.exclude.push("c.rs".into());
    fs::write(
        dir.path().join(".mimirs/config.toml"),
        config.to_toml().unwrap(),
    )
    .unwrap();
    fs::set_permissions(dir.path().join("d.rs"), fs::Permissions::from_mode(0o000)).unwrap();
    assert!(fs::read(dir.path().join("d.rs")).is_err());
    let (result, stdout, stderr) = run(&dir, backend(), false);
    result.unwrap();
    assert!(stdout.starts_with("indexed: 0 files\nunchanged: 1 files\nskipped: 1 files"));
    assert!(stderr.contains("cannot read source file d.rs"));
    assert_eq!(files(&dir), [("a.rs".into(), "keep".into())]);
    assert_eq!(counts(&dir), [1, 1, 1, 1, 3]);
    fs::remove_file(dir.path().join("a.rs")).unwrap();
    fs::remove_file(dir.path().join("d.rs")).unwrap();
    run(&dir, backend(), false).0.unwrap();
    assert_eq!(counts(&dir), [0, 0, 0, 0, 3]);
}

#[test]
fn walk_errors_are_listed_after_discovery_and_do_not_block_cleanup() {
    let dir = project(&[("a.rs", "keep"), ("locked/b.rs", "old")]);
    run(&dir, backend(), false).0.unwrap();
    let locked = dir.path().join("locked");
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
    let (result, stdout, stderr) = run(&dir, backend(), false);
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
    result.unwrap();
    assert!(stdout.contains("skipped: 0 files\nwalk_errors: 1\n"));
    let error = stderr.find("walk_error:").unwrap();
    assert!(error > stderr.rfind("phase: walking").unwrap());
    assert!(error < stderr.find("phase: indexing").unwrap());
    assert!(stderr[error..].contains("locked"));
    assert!(stderr[error..].contains("Permission denied"));
    assert_eq!(files(&dir), [("a.rs".into(), "keep".into())]);
    assert_eq!(counts(&dir), [1, 1, 1, 1, 3]);
}

#[test]
fn embedding_failure_preserves_earlier_commits_and_omits_cleanup() {
    let dir = project(&[("a.rs", "old a"), ("b.rs", "old b"), ("stale.rs", "stale")]);
    run(&dir, backend(), false).0.unwrap();
    fs::write(dir.path().join("a.rs"), "new a").unwrap();
    fs::write(dir.path().join("b.rs"), "fail").unwrap();
    fs::remove_file(dir.path().join("stale.rs")).unwrap();
    let mut model = backend();
    model.fail_on = Some("b.rs\nfail".into());
    let (result, stdout, stderr) = run(&dir, model, true);
    assert!(format!("{:#}", result.unwrap_err()).contains("cannot embed source file b.rs"));
    assert!(stdout.is_empty());
    assert!(stderr.ends_with("\x1b[6F\x1b[J"));
    assert_eq!(
        files(&dir),
        [
            ("a.rs".into(), "new a".into()),
            ("stale.rs".into(), "stale".into())
        ]
    );
}

#[test]
fn progress_failure_keeps_prior_commits_and_stops_before_save_or_cleanup() {
    struct ClosedProgress {
        output: Vec<u8>,
    }

    impl Write for ClosedProgress {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            let batch = b"256/257 documents";
            if bytes.windows(batch.len()).any(|part| part == batch) {
                return Err(io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    "progress output closed",
                ));
            }
            self.output.write(bytes)
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    let dir = project(&[("a.rs", "old a"), ("b.rs", "old b"), ("stale.rs", "stale")]);
    run(&dir, backend(), false).0.unwrap();
    fs::write(dir.path().join("a.rs"), "new a").unwrap();
    fs::write(
        dir.path().join("b.rs"),
        (0..257)
            .map(|n| format!("fn f{n}() {{}}\n"))
            .collect::<String>(),
    )
    .unwrap();
    fs::remove_file(dir.path().join("stale.rs")).unwrap();
    let model = backend();
    let calls = Rc::clone(&model.calls);
    let mut stdout = Vec::new();
    let mut stderr = ClosedProgress { output: Vec::new() };

    let error = run_at(
        dir.path(),
        || Ok(Embedder::new(model)),
        &mut stdout,
        &mut stderr,
        true,
        &|| Duration::ZERO,
    )
    .unwrap_err();

    assert_eq!(
        error.downcast_ref::<io::Error>().unwrap().kind(),
        io::ErrorKind::BrokenPipe
    );
    assert!(stdout.is_empty());
    assert!(stderr.output.ends_with(b"\x1b[6F\x1b[J"));
    assert_eq!(
        calls
            .borrow()
            .batches
            .iter()
            .map(Vec::len)
            .collect::<Vec<_>>(),
        [1, 256]
    );
    assert_eq!(
        files(&dir),
        [
            ("a.rs".into(), "new a".into()),
            ("stale.rs".into(), "stale".into()),
        ]
    );
}

#[test]
fn preparation_failure_has_no_success_summary() {
    let dir = project(&[("a.rs", "text")]);
    let mut model = backend();
    model.prepare = Some(Box::new(|| anyhow::bail!("model unavailable")));
    let (result, stdout, stderr) = run(&dir, model, false);
    assert!(format!("{:#}", result.unwrap_err()).contains("model unavailable"));
    assert!(stdout.is_empty());
    assert_eq!(
        stderr,
        include_str!("../../goldens/index/preparation_failure.txt")
    );
    assert_eq!(counts(&dir), [0, 0, 0, 0, 0]);
}

#[test]
fn corrupt_model_metadata_aborts_even_without_files() {
    let dir = project(&[("a.rs", "text")]);
    run(&dir, backend(), false).0.unwrap();
    fs::remove_file(dir.path().join("a.rs")).unwrap();
    connection(&dir)
        .execute("DELETE FROM index_metadata", [])
        .unwrap();
    let (result, stdout, _) = run(&dir, backend(), false);
    assert!(format!("{:#}", result.unwrap_err()).contains("missing embedding metadata"));
    assert!(stdout.is_empty());
    assert_eq!(files(&dir), [("a.rs".into(), "text".into())]);
}

#[test]
fn save_and_cleanup_errors_fail_without_losing_prior_rows() {
    for (table, operation) in [("retrieval_documents", "INSERT"), ("files", "DELETE")] {
        let dir = project(&[("a.rs", "old"), ("stale.rs", "stale")]);
        run(&dir, backend(), false).0.unwrap();
        fs::remove_file(dir.path().join("stale.rs")).unwrap();
        fs::write(dir.path().join("a.rs"), "new").unwrap();
        let path = dir.path().join(".mimirs/index.db");
        let mut model = backend();
        model.prepare = Some(Box::new(move || {
            Connection::open(&path)?.execute_batch(&format!(
                "CREATE TRIGGER fail BEFORE {operation} ON {table} BEGIN SELECT RAISE(ABORT, 'forced failure'); END;"
            ))?;
            Ok(())
        }));
        let (result, stdout, stderr) = run(&dir, model, true);
        assert!(format!("{:#}", result.unwrap_err()).contains("forced failure"));
        assert!(stdout.is_empty());
        assert!(stderr.ends_with("\x1b[6F\x1b[J"));
        let expected = if operation == "INSERT" {
            vec![("stale.rs".into(), "stale".into())]
        } else {
            vec![
                ("a.rs".into(), "old".into()),
                ("stale.rs".into(), "stale".into()),
            ]
        };
        assert_eq!(files(&dir), expected);
        let count = if operation == "INSERT" { 1 } else { 2 };
        assert_eq!(counts(&dir), [count, count, count, count, 3]);
    }
}

#[test]
fn config_errors_precede_model_creation_and_database_changes() {
    let dir = project(&[]);
    fs::remove_file(dir.path().join(".mimirs/config.toml")).unwrap();
    let result = run_at(
        dir.path(),
        || panic!("model created"),
        &mut Vec::new(),
        &mut Vec::new(),
        false,
        &|| Duration::ZERO,
    );
    assert!(format!("{:#}", result.unwrap_err()).contains("run `mimirs init`"));
    assert!(!dir.path().join(".mimirs/index.db").exists());
}

#[test]
fn a_file_removed_after_discovery_is_a_read_skip() {
    let dir = project(&[("a.rs", "source")]);
    run(&dir, backend(), false).0.unwrap();
    let path = dir.path().join("a.rs");
    let mut model = backend();
    model.prepare = Some(Box::new(move || Ok(fs::remove_file(&path)?)));
    let (result, stdout, stderr) = run(&dir, model, false);
    result.unwrap();
    assert!(
        stdout.starts_with(
            "indexed: 0 files\nunchanged: 0 files\nskipped: 1 files\nwalk_errors: 0\n"
        )
    );
    assert!(stderr.contains("cannot read source file a.rs"));
    assert!(stderr.contains("index_progress: 100% (1/1 files)"));
    assert_eq!(counts(&dir), [0, 0, 0, 0, 3]);
}

#[test]
fn unknown_schema_fails_before_model_creation() {
    let dir = project(&[("a.rs", "source")]);
    let path = dir.path().join(".mimirs/index.db");
    let db = Connection::open(&path).unwrap();
    db.execute_batch("CREATE TABLE foreign_data(value); PRAGMA user_version = 99;")
        .unwrap();
    drop(db);
    let before = fs::read(&path).unwrap();
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let result = run_at(
        dir.path(),
        || panic!("model created"),
        &mut stdout,
        &mut stderr,
        true,
        &|| Duration::ZERO,
    );
    assert!(format!("{:#}", result.unwrap_err()).contains("newer than supported"));
    assert!(stdout.is_empty());
    assert!(stderr.ends_with(b"\x1b[5F\x1b[J"));
    assert_eq!(fs::read(&path).unwrap(), before);
}

#[test]
fn extraction_shares_one_read_and_mixed_types_keep_embedding_inputs() {
    use std::cell::Cell;
    let dir = project(&[("a.rs", "fn f() {}"), ("b.txt", "plain")]);
    fs::write(
        dir.path().join(".mimirs/config.toml"),
        "include = [\"**/*.rs\", \"**/*.txt\"]\nexclude = []\n",
    )
    .unwrap();
    let reads = Cell::new(0);
    let parses = Cell::new(0);
    let mut stderr = Vec::new();
    let mut progress = Progress::new(dir.path(), &mut stderr, false, &|| Duration::ZERO);
    let model = backend();
    let calls = Rc::clone(&model.calls);
    let summary = index_with(
        dir.path(),
        || Ok(Embedder::new(model)),
        &mut progress,
        |root, path| {
            reads.set(reads.get() + 1);
            source::read(root, path)
        },
        |source| {
            parses.set(parses.get() + 1);
            crate::analysis::extract(source)
        },
    )
    .unwrap();
    assert_eq!((reads.get(), parses.get(), summary.indexed), (2, 2, 2));
    assert_eq!(
        calls.borrow().batches,
        [vec!["a.rs\nfn f() {}"], vec!["b.txt\nplain"]]
    );
    let db = connection(&dir);
    assert_eq!(
        storage::analysis::load(&db, "a.rs")
            .unwrap()
            .unwrap()
            .source
            .text,
        "fn f() {}"
    );
    let text = storage::analysis::load(&db, "b.txt").unwrap().unwrap();
    assert!(text.entities.is_empty() && text.facts.is_empty());
    assert!(crate::analysis::report(&text).contains("not parsed"));
}

#[test]
fn fatal_parser_error_removes_previous_analysis_and_vectors() {
    let dir = project(&[("a.rs", "fn old() {}")]);
    run(&dir, backend(), false).0.unwrap();
    fs::write(dir.path().join("a.rs"), "fn changed() {}").unwrap();
    let mut stderr = Vec::new();
    let mut progress = Progress::new(dir.path(), &mut stderr, false, &|| Duration::ZERO);
    let result = index_with(
        dir.path(),
        || Ok(Embedder::new(backend())),
        &mut progress,
        source::read,
        |_| anyhow::bail!("parser failed"),
    );
    assert!(format!("{:#}", result.err().unwrap()).contains("parser failed"));
    assert_eq!(counts(&dir), [0, 0, 0, 0, 3]);
    assert!(
        storage::analysis::load(&connection(&dir), "a.rs")
            .unwrap()
            .is_none()
    );
}

#[test]
fn incomplete_and_empty_replacements_remove_old_facts() {
    let dir = project(&[("a.rs", "fn old() {}")]);
    run(&dir, backend(), false).0.unwrap();
    for text in ["fn broken(", " \r\n", ""] {
        fs::write(dir.path().join("a.rs"), text).unwrap();
        let (result, _, stderr) = run(&dir, backend(), false);
        result.unwrap();
        let a = storage::analysis::load(&connection(&dir), "a.rs")
            .unwrap()
            .unwrap();
        assert_eq!(a.source.text, text);
        assert!(!a.entities.iter().any(|e| e.name.as_deref() == Some("old")));
        assert_eq!(stderr.contains("syntax: a.rs:"), !a.diagnostics.is_empty());
    }
    assert_eq!(counts(&dir), [1, 1, 0, 0, 3]);
}

#[test]
fn reuse_skips_parsing_and_inference_and_preserves_rows() {
    let dir = project(&[("a.rs", "fn old() {}"), ("broken.rs", "fn (")]);
    run(&dir, backend(), false).0.unwrap();
    let original: Vec<(i64, String)> = connection(&dir)
        .prepare("SELECT file_id, payload FROM analysis_records ORDER BY file_id")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    let model = backend();
    let calls = Rc::clone(&model.calls);
    let mut stderr = Vec::new();
    let mut progress = Progress::new(dir.path(), &mut stderr, false, &|| Duration::ZERO);
    let summary = index_with(
        dir.path(),
        || Ok(Embedder::new(model)),
        &mut progress,
        source::read,
        |_| panic!("reused file parsed"),
    )
    .unwrap();
    assert_eq!(
        (summary.indexed, summary.unchanged, summary.skipped),
        (0, 2, 0)
    );
    assert!(calls.borrow().batches.is_empty());
    let saved: Vec<(i64, String)> = connection(&dir)
        .prepare("SELECT file_id, payload FROM analysis_records ORDER BY file_id")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(saved, original);
    let (_, stdout, _) = run(&dir, backend(), false);
    assert!(stdout.starts_with("indexed: 0 files\nunchanged: 2 files\nskipped: 0 files\n"));
}

#[test]
fn content_hash_detects_same_length_edit_with_same_timestamp() {
    let dir = project(&[("a.rs", "fn old() {}"), ("b.rs", "fn keep() {}")]);
    run(&dir, backend(), false).0.unwrap();
    let path = dir.path().join("a.rs");
    let modified = fs::metadata(&path).unwrap().modified().unwrap();
    fs::write(&path, "fn new() {}").unwrap();
    fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(modified))
        .unwrap();
    let model = backend();
    let calls = Rc::clone(&model.calls);
    let (result, stdout, _) = run(&dir, model, false);
    result.unwrap();
    assert!(stdout.starts_with("indexed: 1 files\nunchanged: 1 files\nskipped: 0 files\n"));
    assert_eq!(calls.borrow().batches, [vec!["a.rs\nfn new() {}"]]);
    assert_eq!(
        storage::analysis::load(&connection(&dir), "a.rs")
            .unwrap()
            .unwrap()
            .source
            .text,
        "fn new() {}"
    );
}

#[test]
fn stale_versions_and_missing_output_force_reprocessing() {
    let dir = project(&[("a.rs", "fn f() {}")]);
    run(&dir, backend(), false).0.unwrap();
    for mutation in [
        "UPDATE source_snapshots SET analysis_version='old'",
        "UPDATE index_metadata SET value='old' WHERE key='document_policy'",
        "DELETE FROM analysis_records",
        "UPDATE entities SET byte_end=999",
        "DELETE FROM document_embeddings",
        "DELETE FROM retrieval_processing",
    ] {
        connection(&dir).execute(mutation, []).unwrap();
        let model = backend();
        let calls = Rc::clone(&model.calls);
        let (result, stdout, _) = run(&dir, model, false);
        result.unwrap();
        assert!(
            stdout.starts_with("indexed: 1 files\nunchanged: 0 files\n"),
            "{mutation}: {stdout}"
        );
        assert_eq!(calls.borrow().batches.len(), 1, "{mutation}");
    }
}

#[test]
fn failed_source_replacement_cannot_return_old_code() {
    let dir = project(&[("a.rs", "fn old() {}")]);
    let config = Config {
        ..Config::default()
    };
    fs::write(
        dir.path().join(".mimirs/config.toml"),
        config.to_toml().unwrap(),
    )
    .unwrap();
    run(&dir, backend(), false).0.unwrap();
    fs::write(dir.path().join("a.rs"), "fn new() {}").unwrap();
    let mut failing = backend();
    failing.fail_on = Some("a.rs\nfn new() {}".into());
    assert!(run(&dir, failing, false).0.is_err());
    let db = connection(&dir);
    assert!(storage::analysis::load(&db, "a.rs").unwrap().is_none());
    assert!(
        storage::nearest(&db, &vec![1.0; DIMENSION], 10)
            .unwrap()
            .is_empty()
    );
    drop(db);
    run(&dir, backend(), false).0.unwrap();
    fs::remove_file(dir.path().join("a.rs")).unwrap();
    run(&dir, backend(), false).0.unwrap();
    assert!(
        storage::nearest(&connection(&dir), &vec![1.0; DIMENSION], 10)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn obsolete_config_fails_before_opening_or_rebuilding_an_index() {
    let dir = project(&[("a.rs", "fn old() {}")]);
    run(&dir, backend(), false).0.unwrap();
    let db_path = dir.path().join(".mimirs/index.db");
    let before = fs::read(&db_path).unwrap();
    let config_path = dir.path().join(".mimirs/config.toml");
    let original = fs::read_to_string(&config_path).unwrap();
    fs::write(&config_path, format!("{original}\nretrieval = \"raw\"\n")).unwrap();
    let result = run_at(
        dir.path(),
        || panic!("created model"),
        &mut Vec::new(),
        &mut Vec::new(),
        false,
        &|| Duration::ZERO,
    );
    assert!(format!("{:#}", result.unwrap_err()).contains("remove this key"));
    assert_eq!(fs::read(&db_path).unwrap(), before);
}

#[test]
fn previous_modes_rebuild_to_source_and_keep_custom_includes() {
    for mode in ["raw", "facts", "source"] {
        let dir = project(&[("a.rs", "fn f() {}"), ("b.txt", "first\nsecond\n\nthird")]);
        let config_path = dir.path().join(".mimirs/config.toml");
        let config = "include = [\"**/*.rs\", \"**/*.txt\"]\nexclude = [\"private/**\"]\n";
        fs::write(&config_path, config).unwrap();
        drop(storage::open(&dir.path().join("register.db")).unwrap());
        let db = connection(&dir);
        db.execute_batch(include_str!("../../../src/storage/schema_v7.sql"))
            .unwrap();
        db.pragma_update(None, "user_version", 7).unwrap();
        db.execute(
            "INSERT INTO index_metadata VALUES ('retrieval_mode', ?1)",
            [mode],
        )
        .unwrap();
        drop(db);
        let before = fs::read(dir.path().join(".mimirs/index.db")).unwrap();
        assert!(
            format!(
                "{:#}",
                storage::open_read_only(&dir.path().join(".mimirs/index.db")).unwrap_err()
            )
            .contains("mimirs index")
        );
        assert_eq!(
            fs::read(dir.path().join(".mimirs/index.db")).unwrap(),
            before
        );
        let model = backend();
        let calls = model.calls.clone();
        let (result, stdout, stderr) = run(&dir, model, false);
        result.unwrap();
        assert!(stdout.starts_with("indexed: 2 files"));
        assert!(stderr.contains("rebuilt"));
        assert_eq!(
            calls.borrow().batches,
            [
                vec!["a.rs\nfn f() {}"],
                vec!["b.txt\nfirst\nsecond\n", "b.txt\nthird"]
            ]
        );
        assert_eq!(fs::read_to_string(config_path).unwrap(), config);
        let (_, stdout, _) = run(&dir, backend(), false);
        assert!(stdout.contains("unchanged: 2 files"));
    }
}

#[test]
fn registering_an_analyzer_replaces_unchanged_fallback_documents() {
    let dir = project(&[("a.rs", "fn first() {}\nfn second() {}")]);
    // Simulate the stored output of a release whose registry had only fallback.
    let mut analysis = crate::analysis::extract(source::SourceFile {
        path: "a.txt".into(),
        text: fs::read_to_string(dir.path().join("a.rs")).unwrap(),
    })
    .unwrap();
    analysis.source.path = "a.rs".into();
    let budget =
        crate::retrieval::split::TokenBudget::new(crate::test_support::tokenizer(512)).unwrap();
    let policy = storage::policy::document_policy(&budget);
    let documents = crate::retrieval::source::documents(&analysis, &budget).unwrap();
    assert_eq!(documents.len(), 1);
    assert_eq!(documents[0].owner, None);
    let mut db = storage::open(&dir.path().join(".mimirs/index.db"))
        .unwrap()
        .connection;
    storage::documents::save(
        &mut db,
        &analysis,
        storage::documents::Batch {
            documents: &documents,
            vectors: &[vec![1.0; DIMENSION]],
            policy: &policy,
        },
    )
    .unwrap();
    let fallback = crate::analysis::language::for_path("a.txt");
    let old_registry = format!(
        "analyzers-1:{}",
        serde_json::to_string(&[(fallback.extensions, fallback.identity)]).unwrap()
    );
    let old_policy = policy.replacen(
        &crate::analysis::language::registry_identity(),
        &old_registry,
        1,
    );
    db.execute(
        "UPDATE source_snapshots SET analysis_version=?1",
        [fallback.identity],
    )
    .unwrap();
    for sql in [
        "UPDATE index_metadata SET value=?1 WHERE key='document_policy'",
        "UPDATE retrieval_processing SET policy=?1",
        "UPDATE retrieval_documents SET policy=?1",
    ] {
        db.execute(sql, [&old_policy]).unwrap();
    }
    assert!(!storage::processing::reusable(&db, &analysis.source, &policy).unwrap());
    assert!(
        storage::policy::read(&db)
            .unwrap_err()
            .to_string()
            .contains("run mimirs index")
    );
    assert!(
        storage::analysis::load(&db, "a.rs")
            .unwrap_err()
            .to_string()
            .contains("run mimirs index")
    );
    drop(db);

    let model = backend();
    let calls = Rc::clone(&model.calls);
    let (result, stdout, _) = run(&dir, model, false);
    result.unwrap();
    assert!(stdout.starts_with("indexed: 1 files\nunchanged: 0 files\n"));
    assert_eq!(
        calls.borrow().batches,
        [vec!["a.rs\nfn first() {}", "a.rs\nfn second() {}"]]
    );
    let db = connection(&dir);
    let stored = storage::analysis::load(&db, "a.rs").unwrap().unwrap();
    assert_eq!(stored.source, analysis.source);
    assert_eq!(stored.entities.len(), 2);
    assert_eq!(
        storage::documents::load(&db, "a.rs", &policy)
            .unwrap()
            .len(),
        2
    );
    assert!(storage::processing::reusable(&db, &stored.source, &policy).unwrap());
    assert_eq!(
        db.query_row("SELECT count(*) FROM document_embeddings", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        2
    );
    let model = backend();
    let calls = Rc::clone(&model.calls);
    let (result, stdout, _) = run(&dir, model, false);
    result.unwrap();
    assert!(stdout.starts_with("indexed: 0 files\nunchanged: 1 files\n"));
    assert!(calls.borrow().batches.is_empty());
}

#[test]
fn python_and_rust_share_index_reuse_replacement_and_deletion() {
    let dir = project(&[
        (
            "a.py",
            "class Store:\n    def read(self):\n        \"\"\"Read state.\"\"\"\n        return self.state\n",
        ),
        ("api.pyi", "def read() -> str: ...\n"),
        ("empty.py", ""),
        ("keep.rs", "fn keep() {}"),
    ]);
    let config_path = dir.path().join(".mimirs/config.toml");
    let original_config = fs::read(&config_path).unwrap();
    run(&dir, backend(), false).0.unwrap();
    let budget =
        crate::retrieval::split::TokenBudget::new(crate::test_support::tokenizer(512)).unwrap();
    let policy = storage::policy::document_policy(&budget);
    for path in ["a.py", "api.pyi", "empty.py", "keep.rs"] {
        let expected = crate::analysis::extract(source::read(dir.path(), path).unwrap()).unwrap();
        let db = connection(&dir);
        let stored = storage::analysis::load(&db, path).unwrap().unwrap();
        assert_eq!(stored, expected);
        assert_eq!(
            storage::documents::load(&db, path, &policy).unwrap(),
            crate::retrieval::source::documents(&expected, &budget).unwrap()
        );
    }
    assert!(
        storage::documents::load(&connection(&dir), "empty.py", &policy)
            .unwrap()
            .is_empty()
    );
    let model = backend();
    let calls = Rc::clone(&model.calls);
    let mut stderr = Vec::new();
    let mut progress = Progress::new(dir.path(), &mut stderr, false, &|| Duration::ZERO);
    let summary = index_with(
        dir.path(),
        || Ok(Embedder::new(model)),
        &mut progress,
        source::read,
        |_| panic!("unchanged source parsed"),
    )
    .unwrap();
    assert_eq!((summary.indexed, summary.unchanged), (0, 4));
    assert!(calls.borrow().batches.is_empty());

    fs::write(dir.path().join("a.py"), "def changed():\n    return 42\n").unwrap();
    fs::remove_file(dir.path().join("api.pyi")).unwrap();
    let (result, stdout, _) = run(&dir, backend(), false);
    result.unwrap();
    assert!(
        stdout.starts_with("indexed: 1 files\nunchanged: 2 files\n"),
        "{stdout}"
    );
    let db = connection(&dir);
    assert!(storage::analysis::load(&db, "api.pyi").unwrap().is_none());
    let updated = storage::analysis::load(&db, "a.py").unwrap().unwrap();
    assert_eq!(updated.entities.len(), 1);
    assert_eq!(updated.entities[0].name.as_deref(), Some("changed"));
    drop(db);

    fs::write(
        dir.path().join("a.py"),
        "def replacement():\n    return 99\n",
    )
    .unwrap();
    let mut model = backend();
    model.fail_on = Some("a.py\ndef replacement():\n    return 99".into());
    assert!(run(&dir, model, false).0.is_err());
    let db = connection(&dir);
    assert!(storage::analysis::load(&db, "a.py").unwrap().is_none());
    let hits = storage::nearest(&db, &vec![1.0; DIMENSION], 10).unwrap();
    assert!(hits.iter().all(|hit| hit.path == "keep.rs"));
    assert_eq!(fs::read(config_path).unwrap(), original_config);
}
