use std::cell::RefCell;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::rc::Rc;
use std::time::Instant;

use rusqlite::Connection;
use tempfile::TempDir;

use super::*;
use crate::embedding::{Backend, DIMENSION, Embedder};

#[derive(Default)]
struct Calls {
    workers: Option<usize>,
    preparations: usize,
    batches: Vec<Vec<String>>,
}

struct TestBackend {
    calls: Rc<RefCell<Calls>>,
    fail_on: Option<String>,
    prepare: Option<Box<dyn FnMut() -> anyhow::Result<()>>>,
}

impl Backend for TestBackend {
    fn set_workers(&mut self, workers: usize) {
        self.calls.borrow_mut().workers = Some(workers);
    }

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

#[test]
fn the_language_union_shares_reuse_replacement_and_failed_cleanup() {
    let dir = project(&[]);
    fs::write(
        dir.path().join(".mimirs/config.toml"),
        Config::default().to_toml().unwrap(),
    )
    .unwrap();
    let inputs: serde_json::Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/port/languages/inputs.json"
    ))
    .unwrap();
    let mut paths = Vec::new();
    for case in inputs.as_array().unwrap() {
        let path = case["path"].as_str().unwrap();
        fs::write(dir.path().join(path), case["source"].as_str().unwrap()).unwrap();
        paths.push(path.to_owned());
    }
    for ext in crate::analysis::formats::EXTENSIONS {
        let path = format!("archive.{ext}");
        fs::write(
            dir.path().join(&path),
            "Restore café archives.\r\n\r\nUse the manifest.\r\n",
        )
        .unwrap();
        paths.push(path);
    }
    run(&dir, backend(), false).0.unwrap();
    for path in &paths {
        let direct = crate::analysis::extract(source::read(dir.path(), path).unwrap()).unwrap();
        assert_eq!(
            storage::analysis::load(&connection(&dir), path)
                .unwrap()
                .unwrap(),
            direct
        );
    }
    let model = backend();
    let calls = model.calls.clone();
    run(&dir, model, false).0.unwrap();
    assert!(calls.borrow().batches.is_empty());
    for path in &paths {
        fs::write(dir.path().join(path), "replacement_source").unwrap();
        let mut model = backend();
        model.fail_on = Some(format!("File: {path}\nreplacement_source"));
        assert!(run(&dir, model, false).0.is_err(), "{path}");
        let db = connection(&dir);
        assert!(
            storage::analysis::load(&db, path).unwrap().is_none(),
            "{path}"
        );
        assert_eq!(db.query_row("SELECT count(*) FROM retrieval_documents d JOIN files f ON f.id=d.file_id WHERE f.path=?1", [path], |r| r.get::<_, i64>(0)).unwrap(), 0);
        fs::remove_file(dir.path().join(path)).unwrap();
    }
    run(&dir, backend(), false).0.unwrap();
    assert!(files(&dir).is_empty());
}

#[test]
fn worker_config_reaches_backend_and_does_not_invalidate_existing_documents() {
    let dir = project(&[("a.rs", "fn a() {}")]);
    let available = std::thread::available_parallelism().map_or(1, usize::from);
    for (iteration, requested) in [2, 10000].into_iter().enumerate() {
        let config = Config {
            embedding_workers: std::num::NonZeroUsize::new(requested),
            ..Config::default()
        };
        fs::write(
            dir.path().join(".mimirs/config.toml"),
            config.to_toml().unwrap(),
        )
        .unwrap();
        let model = backend();
        let calls = model.calls.clone();
        run(&dir, model, false).0.unwrap();
        assert_eq!(calls.borrow().workers, Some(requested.min(available)));
        assert_eq!(calls.borrow().batches.len(), usize::from(iteration == 0));
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
        [vec!["File: a.rs\nfirst\n\n  second  \n"]]
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
    let text = (0..1025)
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
            [1024, 1]
        );
        assert_eq!(stderr.contains("99% (1024/1025 documents)"), terminal);
        assert_eq!(stderr.contains("\x1b["), terminal);
        assert!(stderr.contains("files_completed: 100% (1/1 files)"));
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
    assert!(error < stderr.find("phase: reused").unwrap());
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
    model.fail_on = Some("File: b.rs\nfail".into());
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
            let batch = b"1024/1025 documents";
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
        (0..1025)
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
        [1, 1024]
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
    assert!(stderr.contains("files_completed: 100% (1/1 files)"));
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
        [vec!["File: a.rs\nfn f() {}"], vec!["File: b.txt\nplain"]]
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
    assert_eq!(calls.borrow().batches, [vec!["File: a.rs\nfn new() {}"]]);
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
    failing.fail_on = Some("File: a.rs\nfn new() {}".into());
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
                vec!["File: a.rs\nfn f() {}"],
                vec!["File: b.txt\nfirst\nsecond\n", "File: b.txt\nthird"]
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
    let documents = crate::retrieval::ts_v2::documents(&analysis).unwrap();
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
        [vec![
            "File: a.rs\nfn first() {}\n",
            "File: a.rs\nfn second() {}"
        ]]
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
            crate::retrieval::ts_v2::documents(&expected).unwrap()
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
    model.fail_on = Some("File: a.py\ndef replacement():\n    return 99\n".into());
    assert!(run(&dir, model, false).0.is_err());
    let db = connection(&dir);
    assert!(storage::analysis::load(&db, "a.py").unwrap().is_none());
    let hits = storage::nearest(&db, &vec![1.0; DIMENSION], 10).unwrap();
    assert!(hits.iter().all(|hit| hit.path == "keep.rs"));
    assert_eq!(fs::read(config_path).unwrap(), original_config);
}

#[test]
fn profiling_preserves_index_output_and_tracks_reuse_and_partial_failure() {
    let a = project(&[("a.rs", "fn a() {}"), ("b.py", "def b(): pass")]);
    let b = project(&[("a.rs", "fn a() {}"), ("b.py", "def b(): pass")]);
    let (plain, stdout, _) = run(&a, backend(), false);
    plain.unwrap();
    for iteration in 0..3 {
        let profile = Profiler::enabled(crate::embedding::model_identity());
        let mut output = Vec::new();
        let mut diagnostics = Vec::new();
        let mut model = backend();
        if iteration == 2 {
            fs::write(b.path().join("b.py"), "def replacement(): pass").unwrap();
            model.prepare = Some(Box::new(|| anyhow::bail!("model unavailable")));
        }
        let result = run_at_profiled(
            b.path(),
            || Ok(Embedder::new(model)),
            &mut output,
            &mut diagnostics,
            false,
            &|| Duration::from_millis(1250),
            &profile,
        );
        let report = profile
            .finish(result.as_ref().err().map(ToString::to_string))
            .unwrap();
        if iteration == 2 {
            assert!(!report.complete);
            assert!(output.is_empty());
            assert!(!report.counters.contains_key("files_indexed"));
        } else {
            result.unwrap();
            assert!(report.complete);
            assert_eq!(report.counters["files_read"], 2);
            assert_eq!(report.files.len(), 2);
            assert_eq!(files(&a), files(&b));
            assert_eq!(counts(&a), counts(&b));
            // Equal logical persisted content includes source, evidence and vectors.
            for table in [
                "source_snapshots",
                "entities",
                "analysis_records",
                "retrieval_documents",
                "document_embeddings",
            ] {
                let dump = |dir: &TempDir| {
                    let db = connection(dir);
                    let mut statement = db
                        .prepare(&format!("SELECT * FROM {table} ORDER BY 1"))
                        .unwrap();
                    let columns = statement.column_count();
                    statement
                        .query_map([], |row| {
                            (0..columns)
                                .map(|i| row.get::<_, rusqlite::types::Value>(i))
                                .collect::<rusqlite::Result<Vec<_>>>()
                        })
                        .unwrap()
                        .collect::<rusqlite::Result<Vec<_>>>()
                        .unwrap()
                };
                assert_eq!(dump(&a), dump(&b));
            }
            if iteration == 0 {
                assert_eq!(output, stdout.as_bytes());
                assert_eq!(report.counters["files_indexed"], 2);
                assert_eq!(report.counters["embedding_calls"], 2);
                assert_eq!(report.counters["embedding_documents"], 2);
            } else {
                assert_eq!(report.counters["files_reused"], 2);
                assert!(!report.phases_seconds.contains_key("analysis"));
                assert!(!report.phases_seconds.contains_key("embedding"));
                assert!(!report.counters.contains_key("embedding_calls"));
            }
        }
    }
}

#[test]
fn javascript_dialects_share_storage_reuse_and_failed_replacement() {
    let dir = project(&[
        (
            "a.ts",
            "/** Store labels. */\nexport class Store { read(value: string) { return value; } }\n",
        ),
        ("api.d.ts", "export declare function read(): string;\n"),
        ("view.tsx", "export const View = () => <div>café</div>;\n"),
        ("module.mjs", "export function read() { return 1; }\n"),
        ("empty.js", ""),
        ("keep.rs", "fn keep() {}"),
        ("keep.py", "def keep(): pass\n"),
    ]);
    run(&dir, backend(), false).0.unwrap();
    let budget =
        crate::retrieval::split::TokenBudget::new(crate::test_support::tokenizer(512)).unwrap();
    let policy = storage::policy::document_policy(&budget);
    for path in [
        "a.ts",
        "api.d.ts",
        "view.tsx",
        "module.mjs",
        "empty.js",
        "keep.rs",
        "keep.py",
    ] {
        let direct = crate::analysis::extract(source::read(dir.path(), path).unwrap()).unwrap();
        let db = connection(&dir);
        let stored = storage::analysis::load(&db, path).unwrap().unwrap();
        assert_eq!(direct, stored);
        assert_eq!(
            storage::documents::load(&db, path, &policy).unwrap(),
            crate::retrieval::ts_v2::documents(&direct).unwrap()
        );
    }
    let model = backend();
    let calls = model.calls.clone();
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
    assert_eq!((summary.indexed, summary.unchanged), (0, 7));
    assert!(calls.borrow().batches.is_empty());
    fs::remove_file(dir.path().join("module.mjs")).unwrap();
    fs::write(
        dir.path().join("a.ts"),
        "export function changed() { return 42; }\n",
    )
    .unwrap();
    let (result, stdout, _) = run(&dir, backend(), false);
    result.unwrap();
    assert!(stdout.starts_with("indexed: 1 files\nunchanged: 5 files\n"));
    assert!(
        storage::analysis::load(&connection(&dir), "module.mjs")
            .unwrap()
            .is_none()
    );
    assert_eq!(
        storage::analysis::load(&connection(&dir), "a.ts")
            .unwrap()
            .unwrap()
            .entities[0]
            .name
            .as_deref(),
        Some("changed")
    );
    fs::write(dir.path().join("a.ts"), "export const replacement = 99;\n").unwrap();
    let mut model = backend();
    model.fail_on = Some("File: a.ts\nexport const replacement = 99;\n".into());
    assert!(run(&dir, model, false).0.is_err());
    assert!(
        storage::analysis::load(&connection(&dir), "a.ts")
            .unwrap()
            .is_none()
    );
    assert!(
        storage::nearest(&connection(&dir), &vec![1.0; DIMENSION], 10)
            .unwrap()
            .iter()
            .all(|h| h.path != "a.ts")
    );
}

#[test]
fn failed_profile_retains_measurements_for_committed_and_failed_files() {
    let dir = project(&[("a.rs", "fn a() {}"), ("b.rs", "fn b() {}")]);
    let profile = Profiler::enabled(crate::embedding::model_identity());
    let mut model = backend();
    model.fail_on = Some("File: b.rs\nfn b() {}".into());
    let result = run_at_profiled(
        dir.path(),
        || Ok(Embedder::new(model)),
        &mut Vec::new(),
        &mut Vec::new(),
        false,
        &|| Duration::ZERO,
        &profile,
    );
    assert!(result.is_err());
    let report = profile
        .finish(result.err().map(|e| format!("{e:#}")))
        .unwrap();
    assert!(!report.complete);
    assert!(report.error.unwrap().contains("inference failed"));
    assert_eq!(report.counters["files_indexed"], 1);
    assert_eq!(report.counters["embedding_calls"], 2);
    assert_eq!(report.files.len(), 2);
    assert_eq!(files(&dir), [("a.rs".into(), "fn a() {}".into())]);
}

#[test]
fn go_storage_reuse_edits_and_failed_replacement_share_the_pipeline() {
    let dir = project(&[
        ("a.go", include_str!("../../fixtures/go/declarations.go")),
        ("empty.go", ""),
        ("remove.go", "package cache\nfunc removed() {}\n"),
        ("keep.rs", "fn keep() {}"),
        ("keep.py", "def keep(): pass\n"),
        ("keep.ts", "export const keep = 1;\n"),
    ]);
    run(&dir, backend(), false).0.unwrap();
    let budget =
        crate::retrieval::split::TokenBudget::new(crate::test_support::tokenizer(512)).unwrap();
    let policy = storage::policy::document_policy(&budget);
    for path in [
        "a.go",
        "empty.go",
        "remove.go",
        "keep.rs",
        "keep.py",
        "keep.ts",
    ] {
        let direct = crate::analysis::extract(source::read(dir.path(), path).unwrap()).unwrap();
        let db = connection(&dir);
        assert_eq!(storage::analysis::load(&db, path).unwrap().unwrap(), direct);
        assert_eq!(
            storage::documents::load(&db, path, &policy).unwrap(),
            crate::retrieval::ts_v2::documents(&direct).unwrap()
        );
    }
    let model = backend();
    let calls = model.calls.clone();
    let mut stderr = Vec::new();
    let mut progress = Progress::new(dir.path(), &mut stderr, false, &|| Duration::ZERO);
    let summary = index_with(
        dir.path(),
        || Ok(Embedder::new(model)),
        &mut progress,
        source::read,
        |_| panic!("unchanged Go source parsed"),
    )
    .unwrap();
    assert_eq!((summary.indexed, summary.unchanged), (0, 6));
    assert!(calls.borrow().batches.is_empty());
    fs::remove_file(dir.path().join("remove.go")).unwrap();
    fs::write(
        dir.path().join("a.go"),
        "package cache\nfunc changed() {}\n",
    )
    .unwrap();
    fs::write(dir.path().join("keep.ts"), "export const changed = 2;\n").unwrap();
    let (result, stdout, _) = run(&dir, backend(), false);
    result.unwrap();
    assert!(stdout.starts_with("indexed: 2 files\nunchanged: 3 files\n"));
    assert!(
        storage::analysis::load(&connection(&dir), "remove.go")
            .unwrap()
            .is_none()
    );
    assert_eq!(
        storage::analysis::load(&connection(&dir), "a.go")
            .unwrap()
            .unwrap()
            .entities[0]
            .name
            .as_deref(),
        Some("changed")
    );
    fs::write(
        dir.path().join("a.go"),
        "package cache\nvar replacement = 99\n",
    )
    .unwrap();
    let mut model = backend();
    model.fail_on = Some("File: a.go\nvar replacement = 99\n".into());
    assert!(run(&dir, model, false).0.is_err());
    assert!(
        storage::analysis::load(&connection(&dir), "a.go")
            .unwrap()
            .is_none()
    );
    assert!(
        storage::nearest(&connection(&dir), &vec![1.0; DIMENSION], 10)
            .unwrap()
            .iter()
            .all(|h| h.path != "a.go")
    );
}

struct AsyncBackend {
    pool: crate::embedding::pool::Pool,
    limit: usize,
}

impl Backend for AsyncBackend {
    fn take_worker(&mut self) -> Option<Box<dyn Backend + Send>> {
        let pool = embedding::pool::Pool::new(vec![()], |_, _| unreachable!()).unwrap();
        Some(Box::new(Self {
            pool: std::mem::replace(&mut self.pool, pool),
            limit: self.limit,
        }))
    }
    fn pending_files(&self) -> usize {
        self.limit
    }
    fn tokenizer(&mut self) -> anyhow::Result<tokenizers::Tokenizer> {
        Ok(crate::test_support::tokenizer(512))
    }
    fn submit_source(
        &mut self,
        texts: &[String],
        _: &Profiler,
    ) -> anyhow::Result<Option<embedding::SourceTask>> {
        let plans = (0..texts.len()).map(|i| vec![i]).collect();
        Ok(Some(embedding::SourceTask::pending(
            self.pool.submit(texts.to_vec()),
            plans,
            texts.iter().map(String::len).sum(),
            texts.len(),
        )))
    }
    fn embed(&mut self, _: &[String]) -> anyhow::Result<Vec<Vec<f32>>> {
        anyhow::bail!("synchronous inference used")
    }
}

fn fake_vector(text: &str) -> Vec<f32> {
    let mut vector = vec![0.0; DIMENSION];
    vector[0] = text.len() as f32;
    vector[1] = 1.0;
    vector
}

#[test]
fn bounded_pipeline_runs_files_concurrently_and_commits_in_source_order() {
    use std::sync::{Arc, Mutex, mpsc};
    use std::time::Duration;
    let dir = project(&[
        ("a.rs", "first"),
        ("b.rs", "second"),
        ("c.rs", "third"),
        ("d.rs", "fourth"),
    ]);
    let (started, receive) = mpsc::channel();
    let (release, released) = mpsc::channel();
    let released = Arc::new(Mutex::new(released));
    let pool = embedding::pool::Pool::new(vec![(); 3], move |_, text| {
        if !text.contains("fourth") {
            started.send(()).unwrap();
            released
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(5))??;
        }
        Ok(fake_vector(text))
    })
    .unwrap();
    let controller = std::thread::spawn(move || {
        let ready = (0..3).all(|_| receive.recv_timeout(Duration::from_secs(5)).is_ok());
        for _ in 0..3 {
            let _ = release.send(if ready {
                Ok(())
            } else {
                Err(anyhow::anyhow!("files did not overlap"))
            });
        }
        ready
    });
    let profile = Profiler::enabled(crate::embedding::model_identity());
    run_at_profiled(
        dir.path(),
        || Ok(Embedder::new(AsyncBackend { pool, limit: 3 })),
        &mut Vec::new(),
        &mut Vec::new(),
        false,
        &|| Duration::ZERO,
        &profile,
    )
    .unwrap();
    assert!(controller.join().unwrap());
    let report = serde_json::to_value(profile.finish(None).unwrap()).unwrap();
    assert_eq!(report["counters"]["index_queue_peak_files"], 3);
    assert_eq!(report["counters"]["embedding_calls"], 4);
    assert_eq!(
        report["files"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f["path"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["a.rs", "b.rs", "c.rs", "d.rs"]
    );
    let db = connection(&dir);
    let paths = db
        .prepare("SELECT path FROM files ORDER BY id")
        .unwrap()
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert_eq!(paths, ["a.rs", "b.rs", "c.rs", "d.rs"]);
    for path in paths {
        let direct = crate::analysis::extract(source::read(dir.path(), &path).unwrap()).unwrap();
        assert_eq!(
            storage::analysis::load(&db, &path).unwrap().unwrap(),
            direct
        );
    }
    assert!(report["phases_seconds"]["embedding_wait"].is_number());
    assert!(!report["phases_seconds"]["embedding"].is_number());
    let phases: f64 = report["phases_seconds"]
        .as_object()
        .unwrap()
        .values()
        .map(|v| v.as_f64().unwrap())
        .sum();
    assert!(phases <= report["wall_seconds"].as_f64().unwrap());
}

#[test]
fn out_of_order_failure_preserves_earlier_commits_and_later_snapshots() {
    use std::sync::{Arc, Condvar, Mutex};
    let dir = project(&[
        ("a.rs", "old a"),
        ("b.rs", "old b"),
        ("c.rs", "old c"),
        ("stale.rs", "stale"),
    ]);
    run(&dir, backend(), false).0.unwrap();
    for path in ["a", "b", "c"] {
        fs::write(dir.path().join(format!("{path}.rs")), format!("new {path}")).unwrap();
    }
    fs::remove_file(dir.path().join("stale.rs")).unwrap();
    let failed = Arc::new((Mutex::new(false), Condvar::new()));
    let pool = embedding::pool::Pool::new(vec![(); 3], move |_, text| {
        if text.ends_with("new a") {
            let (lock, changed) = &*failed;
            let (_guard, timed) = changed
                .wait_timeout_while(lock.lock().unwrap(), Duration::from_secs(5), |failed| {
                    !*failed
                })
                .unwrap();
            anyhow::ensure!(!timed.timed_out(), "later file did not start");
        } else if text.ends_with("new b") {
            *failed.0.lock().unwrap() = true;
            failed.1.notify_all();
            anyhow::bail!("inference failed before earlier file finished");
        }
        Ok(fake_vector(text))
    })
    .unwrap();
    let profile = Profiler::enabled(crate::embedding::model_identity());
    let result = run_at_profiled(
        dir.path(),
        || Ok(Embedder::new(AsyncBackend { pool, limit: 3 })),
        &mut Vec::new(),
        &mut Vec::new(),
        false,
        &|| Duration::ZERO,
        &profile,
    );
    assert!(format!("{:#}", result.unwrap_err()).contains("cannot embed source file b.rs"));
    assert_eq!(
        files(&dir),
        [
            ("a.rs".into(), "new a".into()),
            ("c.rs".into(), "old c".into()),
            ("stale.rs".into(), "stale".into())
        ]
    );
    let report = profile.finish(Some("expected failure".into())).unwrap();
    assert_eq!(report.counters["files_indexed"], 1);
    assert!(report.counters["embedding_calls"] >= 2);
}
#[test]
fn streamed_index_processes_events_without_waiting_for_a_total() {
    let dir = project(&[]);
    for n in 0..200 {
        fs::write(dir.path().join(format!("f{n:03}.rs")), "fn example() {}\n").unwrap();
    }
    let profile = Profiler::enabled(crate::embedding::model_identity());
    let mut stderr = Vec::new();
    let mut progress = Progress::new(dir.path(), &mut stderr, false, &|| Duration::ZERO);
    let first = std::cell::Cell::new(true);
    let summary = index_with_mode(
        dir.path(),
        || Ok(Embedder::new(backend())),
        &mut progress,
        |root, path| {
            if first.replace(false) {
                // Unbounded discovery may finish before the first source read.
                assert!(profile.counter("files_discovered") >= 1);
            }
            source::read(root, path)
        },
        crate::analysis::extract,
        &profile,
        true,
    )
    .unwrap();
    assert_eq!(summary.indexed, 200);
    assert!(
        String::from_utf8(stderr)
            .unwrap()
            .contains("discovery in progress")
    );
    assert_eq!(
        profile.finish(None).unwrap().counters["files_discovered"],
        200
    );
}

fn run_parallel_test(
    root: &Path,
    factory: impl FnOnce() -> anyhow::Result<Embedder>,
    _: &mut dyn Write,
    stderr: &mut dyn Write,
    terminal: bool,
    elapsed: &dyn Fn() -> Duration,
    profile: &Profiler,
) -> anyhow::Result<()> {
    let mut progress = Progress::new(root, stderr, terminal, elapsed).with_profile(profile.clone());
    index_with_mode(
        root,
        factory,
        &mut progress,
        source::read,
        crate::analysis::extract,
        profile,
        true,
    )?;
    Ok(())
}
#[test]
fn parallel_stages_overlap_and_commit_in_source_order() {
    use std::sync::{Arc, Mutex, mpsc};
    use std::time::Duration;
    let dir = project(&[
        ("a.rs", "first"),
        ("b.rs", "second"),
        ("c.rs", "third"),
        ("d.rs", "fourth"),
    ]);
    let (started, receive) = mpsc::channel();
    let (release, released) = mpsc::channel();
    let released = Arc::new(Mutex::new(released));
    let pool = embedding::pool::Pool::new(vec![(); 3], move |_, text| {
        if !text.contains("fourth") {
            started.send(()).unwrap();
            released
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(5))??;
        }
        Ok(fake_vector(text))
    })
    .unwrap();
    let controller = std::thread::spawn(move || {
        let ready = (0..3).all(|_| receive.recv_timeout(Duration::from_secs(5)).is_ok());
        for _ in 0..3 {
            let _ = release.send(if ready {
                Ok(())
            } else {
                Err(anyhow::anyhow!("files did not overlap"))
            });
        }
        ready
    });
    let profile = Profiler::enabled(crate::embedding::model_identity());
    run_parallel_test(
        dir.path(),
        || Ok(Embedder::new(AsyncBackend { pool, limit: 3 })),
        &mut Vec::new(),
        &mut Vec::new(),
        false,
        &|| Duration::ZERO,
        &profile,
    )
    .unwrap();
    assert!(controller.join().unwrap());
    let report = serde_json::to_value(profile.finish(None).unwrap()).unwrap();
    assert!(
        report["counters"]["index_queue_peak_files"]
            .as_u64()
            .unwrap()
            <= 6
    );
    assert_eq!(report["counters"]["embedding_calls"], 4);
    assert_eq!(
        report["files"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f["path"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["a.rs", "b.rs", "c.rs", "d.rs"]
    );
    let db = connection(&dir);
    let paths = db
        .prepare("SELECT path FROM files ORDER BY id")
        .unwrap()
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert_eq!(paths, ["a.rs", "b.rs", "c.rs", "d.rs"]);
    for path in paths {
        let direct = crate::analysis::extract(source::read(dir.path(), &path).unwrap()).unwrap();
        assert_eq!(
            storage::analysis::load(&db, &path).unwrap().unwrap(),
            direct
        );
    }
    assert!(report["phases_seconds"]["embedding_wait"].is_number());
    assert!(!report["phases_seconds"]["embedding"].is_number());
    let phases: f64 = report["phases_seconds"]
        .as_object()
        .unwrap()
        .values()
        .map(|v| v.as_f64().unwrap())
        .sum();
    assert!(phases > 0.0);
}

#[test]
fn parallel_failure_preserves_earlier_commits_and_later_snapshots() {
    use std::sync::{Arc, Condvar, Mutex};
    let dir = project(&[
        ("a.rs", "old a"),
        ("b.rs", "old b"),
        ("c.rs", "old c"),
        ("stale.rs", "stale"),
    ]);
    run(&dir, backend(), false).0.unwrap();
    for path in ["a", "b", "c"] {
        fs::write(dir.path().join(format!("{path}.rs")), format!("new {path}")).unwrap();
    }
    fs::remove_file(dir.path().join("stale.rs")).unwrap();
    let failed = Arc::new((Mutex::new(false), Condvar::new()));
    let pool = embedding::pool::Pool::new(vec![(); 3], move |_, text| {
        if text.ends_with("new a") {
            let (lock, changed) = &*failed;
            let (_guard, timed) = changed
                .wait_timeout_while(lock.lock().unwrap(), Duration::from_secs(5), |failed| {
                    !*failed
                })
                .unwrap();
            anyhow::ensure!(!timed.timed_out(), "later file did not start");
        } else if text.ends_with("new b") {
            *failed.0.lock().unwrap() = true;
            failed.1.notify_all();
            anyhow::bail!("inference failed before earlier file finished");
        }
        Ok(fake_vector(text))
    })
    .unwrap();
    let profile = Profiler::enabled(crate::embedding::model_identity());
    let result = run_parallel_test(
        dir.path(),
        || Ok(Embedder::new(AsyncBackend { pool, limit: 3 })),
        &mut Vec::new(),
        &mut Vec::new(),
        false,
        &|| Duration::ZERO,
        &profile,
    );
    assert!(format!("{:#}", result.unwrap_err()).contains("cannot embed source file b.rs"));
    assert_eq!(
        files(&dir),
        [
            ("a.rs".into(), "new a".into()),
            ("c.rs".into(), "old c".into()),
            ("stale.rs".into(), "stale".into())
        ]
    );
    let report = profile.finish(Some("expected failure".into())).unwrap();
    assert_eq!(report.counters["files_indexed"], 1);
    assert!(report.counters["embedding_calls"] >= 2);
}

#[test]
fn parallel_workers_publish_the_read_snapshot_after_disk_changes() {
    let dir = project(&[("a.rs", "old snapshot"), ("empty.rs", "")]);
    let path = dir.path().join("a.rs");
    let pool = embedding::pool::Pool::new(vec![()], move |_, text| {
        // Inference starts after the parser handed off its immutable source.
        fs::write(&path, "new disk generation")?;
        Ok(fake_vector(text))
    })
    .unwrap();
    run_parallel_test(
        dir.path(),
        || Ok(Embedder::new(AsyncBackend { pool, limit: 2 })),
        &mut Vec::new(),
        &mut Vec::new(),
        false,
        &|| Duration::ZERO,
        &Profiler::default(),
    )
    .unwrap();
    assert_eq!(
        files(&dir),
        [
            ("a.rs".into(), "old snapshot".into()),
            ("empty.rs".into(), "".into())
        ]
    );
    assert_eq!(
        fs::read_to_string(dir.path().join("a.rs")).unwrap(),
        "new disk generation"
    );
    let db = connection(&dir);
    let policy: String = db
        .query_row(
            "SELECT value FROM index_metadata WHERE key='document_policy'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(
        !storage::processing::reusable(&db, &source::read(dir.path(), "a.rs").unwrap(), &policy)
            .unwrap()
    );
}

#[test]
fn parallel_writer_failure_cancels_pending_work_at_the_failed_path() {
    let dir = project(&[
        ("a.rs", "old a"),
        ("b.rs", "old b"),
        ("c.rs", "old c"),
        ("stale.rs", "keep"),
    ]);
    run(&dir, backend(), false).0.unwrap();
    for path in ["a", "b", "c"] {
        fs::write(dir.path().join(format!("{path}.rs")), format!("new {path}")).unwrap();
    }
    fs::remove_file(dir.path().join("stale.rs")).unwrap();
    for i in 0..30 {
        fs::write(dir.path().join(format!("z{i:02}.rs")), "queued source").unwrap();
    }
    let pool = embedding::pool::Pool::new(vec![(); 3], |_, text| Ok(fake_vector(text))).unwrap();
    let result = run_parallel_test(
        dir.path(),
        || {
            // Install only after normal schema validation, before the writer runs.
            connection(&dir).execute_batch("CREATE TRIGGER fail_writer BEFORE INSERT ON files WHEN NEW.path='b.rs' BEGIN SELECT RAISE(FAIL, 'injected writer failure'); END;").unwrap();
            Ok(Embedder::new(AsyncBackend { pool, limit: 6 }))
        },
        &mut Vec::new(),
        &mut Vec::new(),
        false,
        &|| Duration::ZERO,
        &Profiler::default(),
    );
    assert!(format!("{:#}", result.unwrap_err()).contains("injected writer failure"));
    // Remove the test-only trigger before checking the public schema again.
    storage::index_reader(&dir.path().join(".mimirs/index.db")).unwrap();
    let db = rusqlite::Connection::open(dir.path().join(".mimirs/index.db")).unwrap();
    db.execute_batch("DROP TRIGGER fail_writer").unwrap();
    drop(db);
    assert_eq!(
        files(&dir),
        [
            ("a.rs".into(), "new a".into()),
            ("c.rs".into(), "old c".into()),
            ("stale.rs".into(), "keep".into())
        ]
    );
}

#[test]
fn interrupted_parallel_discovery_never_reconciles_unseen_files() {
    let dir = project(&[("a.rs", "old"), ("stale.rs", "retained")]);
    run(&dir, backend(), false).0.unwrap();
    fs::write(dir.path().join("a.rs"), "new").unwrap();
    fs::remove_file(dir.path().join("stale.rs")).unwrap();
    let _lock = lock::acquire(dir.path()).unwrap();
    let mut db = connection(&dir);
    let policy: String = db
        .query_row(
            "SELECT value FROM index_metadata WHERE key='document_policy'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let pool = embedding::pool::Pool::new(vec![(); 3], |_, text| Ok(fake_vector(text))).unwrap();
    let worker = Embedder::new(AsyncBackend { pool, limit: 6 })
        .take_worker()
        .unwrap();
    let events = vec![
        Ok(walk::stream::Event::Path {
            path: "a.rs".into(),
            ordinal: 0,
        }),
        Err(anyhow::anyhow!("interrupted discovery")),
    ];
    let mut output = Vec::new();
    let mut progress = Progress::new(dir.path(), &mut output, false, &|| Duration::ZERO);
    let result = parallel::run(
        dir.path(),
        Box::new(events.into_iter()),
        worker,
        3,
        &mut db,
        &policy,
        &mut progress,
        &Profiler::default(),
        &mut Summary::default(),
    );
    assert!(format!("{:#}", result.unwrap_err()).contains("interrupted discovery"));
    assert_eq!(
        files(&dir),
        [
            ("a.rs".into(), "new".into()),
            ("stale.rs".into(), "retained".into())
        ]
    );
}

struct FailedWindowPlanner {
    inner: Option<Box<dyn Backend + Send>>,
}
impl Backend for FailedWindowPlanner {
    fn take_worker(&mut self) -> Option<Box<dyn Backend + Send>> {
        Some(Box::new(Self {
            inner: self.inner.take(),
        }))
    }
    fn tokenizer(&mut self) -> anyhow::Result<tokenizers::Tokenizer> {
        self.inner.as_mut().unwrap().tokenizer()
    }
    fn submit_source(
        &mut self,
        texts: &[String],
        profile: &Profiler,
    ) -> anyhow::Result<Option<embedding::SourceTask>> {
        anyhow::ensure!(
            !texts.iter().any(|t| t.contains("new b")),
            "window preparation failed"
        );
        self.inner.as_mut().unwrap().submit_source(texts, profile)
    }
    fn embed(&mut self, _: &[String]) -> anyhow::Result<Vec<Vec<f32>>> {
        unreachable!()
    }
}

#[test]
fn window_preparation_failure_preserves_order_and_cleans_staging() {
    let dir = project(&[("a.rs", "old a"), ("b.rs", "old b"), ("c.rs", "old c")]);
    run(&dir, backend(), false).0.unwrap();
    for path in ["a", "b", "c"] {
        fs::write(dir.path().join(format!("{path}.rs")), format!("new {path}")).unwrap();
    }
    let pool = embedding::pool::Pool::new(vec![(); 3], |_, text| Ok(fake_vector(text))).unwrap();
    let backend = FailedWindowPlanner {
        inner: Some(Box::new(AsyncBackend { pool, limit: 6 })),
    };
    let result = run_parallel_test(
        dir.path(),
        || Ok(Embedder::new(backend)),
        &mut Vec::new(),
        &mut Vec::new(),
        false,
        &|| Duration::ZERO,
        &Profiler::default(),
    );
    assert!(format!("{:#}", result.unwrap_err()).contains("window preparation failed"));
    assert_eq!(
        files(&dir),
        [
            ("a.rs".into(), "new a".into()),
            ("c.rs".into(), "old c".into())
        ]
    );
    let db = rusqlite::Connection::open(dir.path().join(".mimirs/staging.db")).unwrap();
    assert_eq!(
        db.query_row("SELECT count(*) FROM work", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn unbounded_writer_queue_grows_and_cancels_without_deadlock() {
    struct ClosedWriter {
        profile: Profiler,
        filled: bool,
    }
    impl Write for ClosedWriter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            if String::from_utf8_lossy(bytes).contains("phase: published\nfile: 00.rs") {
                let start = Instant::now();
                while self.profile.queue_peak("writer") <= 6
                    && start.elapsed() < Duration::from_secs(5)
                {
                    std::thread::sleep(Duration::from_millis(5));
                }
                self.filled = self.profile.queue_peak("writer") > 6;
                return Err(io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    "writer output closed",
                ));
            }
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let dir = project(&[]);
    for i in 0..30 {
        fs::write(dir.path().join(format!("{i:02}.rs")), "old snapshot").unwrap();
    }
    run(&dir, backend(), false).0.unwrap();
    for i in 0..30 {
        fs::write(dir.path().join(format!("{i:02}.rs")), "new snapshot").unwrap();
    }
    let profile = Profiler::enabled(crate::embedding::model_identity());
    let mut output = ClosedWriter {
        profile: profile.clone(),
        filled: false,
    };
    let pool = embedding::pool::Pool::new(vec![(); 3], |_, text| Ok(fake_vector(text))).unwrap();
    let result = run_parallel_test(
        dir.path(),
        || Ok(Embedder::new(AsyncBackend { pool, limit: 6 })),
        &mut Vec::new(),
        &mut output,
        false,
        &|| Duration::ZERO,
        &profile,
    );
    assert!(format!("{:#}", result.unwrap_err()).contains("writer output closed"));
    assert!(
        output.filled,
        "writer queue did not fill while its consumer was blocked"
    );
    let saved = files(&dir);
    assert_eq!(saved[0], ("00.rs".into(), "new snapshot".into()));
    assert!(saved[1..].iter().all(|(_, text)| text == "old snapshot"));
    assert!(
        profile
            .finish(Some("expected failure".into()))
            .unwrap()
            .counters["index_queue_peak_files"]
            >= 1
    );
}

#[test]
fn writer_cache_release_is_limited_to_incremental_publications() {
    let dir = project(&[("a.rs", "old a"), ("b.rs", "unchanged")]);
    let invoke = |profile: &Profiler| {
        let pool =
            embedding::pool::Pool::new(vec![(); 3], |_, text| Ok(fake_vector(text))).unwrap();
        run_parallel_test(
            dir.path(),
            || Ok(Embedder::new(AsyncBackend { pool, limit: 6 })),
            &mut Vec::new(),
            &mut Vec::new(),
            false,
            &|| Duration::ZERO,
            profile,
        )
        .unwrap();
    };
    let profile = Profiler::enabled(crate::embedding::model_identity());
    invoke(&profile);
    let report = profile.finish(None).unwrap();
    assert!(!report.counters.contains_key("writer_cache_releases"));
    fs::write(dir.path().join("a.rs"), "updated a").unwrap();
    fs::write(dir.path().join("c.rs"), "new file").unwrap();
    let profile = Profiler::enabled(crate::embedding::model_identity());
    invoke(&profile);
    let report = profile.finish(None).unwrap();
    assert_eq!(report.counters["writer_cache_releases"], 2);
    assert_eq!(report.counters["files_indexed"], 2);
    assert_eq!(report.counters["files_reused"], 1);
    assert_eq!(
        files(&dir),
        [
            ("a.rs".into(), "updated a".into()),
            ("b.rs".into(), "unchanged".into()),
            ("c.rs".into(), "new file".into())
        ]
    );
    let profile = Profiler::enabled(crate::embedding::model_identity());
    invoke(&profile);
    let report = profile.finish(None).unwrap();
    assert!(!report.counters.contains_key("writer_cache_releases"));
    assert_eq!(report.counters["files_reused"], 3);
}

#[test]
fn complete_processor_reuses_the_production_parallel_session_and_relationships() {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    let dir = project(&[
        ("start.rs", "pub fn start() {}\n"),
        ("finish.rs", "pub fn finish() {}\n"),
    ]);
    let root = dir.path().canonicalize().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let counted = calls.clone();
    let pool = embedding::pool::Pool::new(vec![(); 2], move |_, text| {
        counted.fetch_add(1, Ordering::Relaxed);
        Ok(fake_vector(text))
    })
    .unwrap();
    let profile = Profiler::enabled(embedding::model_identity());
    let mut log = Vec::new();
    let mut progress =
        Progress::new(&root, &mut log, false, &|| Duration::ZERO).with_profile(profile.clone());
    let knowledge = crate::knowledge::observation::Options {
        root: root.clone(),
        ..Default::default()
    };
    let request = || crate::processor::Request {
        root: &root,
        knowledge: &knowledge,
        force: false,
    };
    let mut session = crate::processor::Session::default();
    let first = session
        .process(
            request(),
            || Ok(Embedder::new(AsyncBackend { pool, limit: 2 })),
            crate::analysis::extract,
            &mut progress,
        )
        .unwrap();
    assert!(first.errors.is_empty(), "{:?}", first.errors);
    assert_eq!(first.indexed, 2);
    assert!(first.graph_published);
    assert!(crate::index::graph::read(&root).is_ok());
    let before = calls.load(Ordering::Relaxed);
    let unused = || anyhow::bail!("warm model was discarded");
    let idle = session
        .process(
            request(),
            unused,
            |_| panic!("idle extraction"),
            &mut progress,
        )
        .unwrap();
    assert_eq!(idle.selected_source_reads, 0);
    assert_eq!(idle.embedded_documents, 0);
    assert_eq!(calls.load(Ordering::Relaxed), before);
    fs::write(root.join("start.rs"), "pub fn changed() {}\n").unwrap();
    assert_eq!(
        crate::commands::status::read(&root, crate::status::now())["components"]["relationships"]["status"],
        "unvalidated"
    );
    assert!(crate::index::graph::read(&root).is_err());
    assert_eq!(
        crate::commands::status::read(&root, crate::status::now())["components"]["relationships"]["status"],
        "verified_stale"
    );
    let changed = session
        .process(request(), unused, crate::analysis::extract, &mut progress)
        .unwrap();
    assert!(changed.errors.is_empty(), "{:?}", changed.errors);
    assert_eq!(changed.indexed, 1);
    assert!(calls.load(Ordering::Relaxed) > before);
    assert!(profile.counter("staging_transactions") > 0);
    assert!(crate::index::graph::read(&root).is_ok());
}

#[test]
fn complete_processor_recovers_valid_stages_without_parsing_or_embedding() {
    let dir = project(&[("recover.rs", "pub fn recovered() {}\n")]);
    let root = dir.path().canonicalize().unwrap();
    let analysis = crate::analysis::extract(source::read(&root, "recover.rs").unwrap()).unwrap();
    let documents = crate::retrieval::ts_v2::documents(&analysis).unwrap();
    let vectors: Vec<_> = documents.iter().map(|d| fake_vector(&d.text)).collect();
    let plan = crate::embedding::WindowPlan {
        inputs: std::sync::Arc::new(documents.iter().map(|d| d.text.clone()).collect()),
        documents: std::sync::Arc::new((0..documents.len()).map(|i| vec![i]).collect()),
    };
    let budget =
        crate::retrieval::split::TokenBudget::new(crate::test_support::tokenizer(512)).unwrap();
    let policy = storage::policy::document_policy(&budget);
    let hash = storage::processing::source_hash(&analysis.source.text);
    let key = storage::staging::Key {
        ordinal: 7,
        path: "recover.rs",
        source_hash: &hash,
        policy: &policy,
    };
    let mut stage = storage::staging::Store::open_for(
        &root.join(".mimirs/staging.db"),
        &Profiler::default(),
        true,
    )
    .unwrap();
    for payload in [
        storage::staging::Stage::Discovered,
        storage::staging::Stage::Source(&analysis),
        storage::staging::Stage::Windows(&documents, &plan),
        storage::staging::Stage::Vectors(&vectors),
    ] {
        stage.record(&key, payload).unwrap();
    }
    drop(stage); // Committed stages from an interrupted process.
    // Current discovery may reach the writer before the parser checks recovery.
    let mut newer = storage::staging::Store::open_for(
        &root.join(".mimirs/staging.db"),
        &Profiler::default(),
        true,
    )
    .unwrap();
    newer
        .record(&key, storage::staging::Stage::Discovered)
        .unwrap();
    assert!(storage::staging::recover(&root, "recover.rs", &hash, &policy).is_some());
    drop(newer);
    let pool = embedding::pool::Pool::new(vec![()], |_, _| {
        anyhow::bail!("recovered vectors embedded again")
    })
    .unwrap();
    let mut log = Vec::new();
    let mut progress = Progress::new(&root, &mut log, false, &|| Duration::ZERO);
    let options = crate::knowledge::observation::Options {
        root: root.clone(),
        ..Default::default()
    };
    let result = crate::processor::Session::default()
        .process(
            crate::processor::Request {
                root: &root,
                knowledge: &options,
                force: true,
            },
            || Ok(Embedder::new(AsyncBackend { pool, limit: 1 })),
            |_| panic!("recovered source parsed again"),
            &mut progress,
        )
        .unwrap();
    assert!(result.errors.is_empty(), "{:?}", result.errors);
    assert_eq!(result.recovered, 1);
    assert_eq!(result.analyzed, 0);
    assert_eq!(result.embedded_documents, 0);
    assert_eq!(result.indexed, 1);
    assert!(crate::index::graph::read(&root).is_ok());
    assert!(storage::staging::recover(&root, "recover.rs", &hash, &policy).is_none());
}

#[test]
fn production_parallel_progress_reports_documents_empty_and_reused_in_both_outputs() {
    for terminal in [false, true] {
        let dir = project(&[
            ("a.rs", "pub fn alpha() {}\npub fn beta() {}\n"),
            ("empty.rs", ""),
        ]);
        let profile = Profiler::enabled(crate::embedding::model_identity());
        let mut output = Vec::new();
        let pool =
            embedding::pool::Pool::new(vec![(); 2], |_, text| Ok(fake_vector(text))).unwrap();
        run_parallel_test(
            dir.path(),
            || Ok(Embedder::new(AsyncBackend { pool, limit: 2 })),
            &mut Vec::new(),
            &mut output,
            terminal,
            &|| Duration::ZERO,
            &profile,
        )
        .unwrap();
        let text = String::from_utf8(output).unwrap();
        let count: i64 = connection(&dir)
            .query_row("SELECT count(*) FROM retrieval_documents", [], |r| r.get(0))
            .unwrap();
        assert!(count > 0);
        assert!(
            text.contains(&format!("100% ({count}/{count} documents)")),
            "{text}"
        );
        assert!(
            text.contains("phase: empty\nfile: empty.rs\nfile_progress: 0/0 documents (no work)"),
            "{text}"
        );
        assert!(!text.contains("100% (0/0"));
        assert!(!text.contains("documents: a.rs"));
        assert!(text.contains("source_processing: complete"));
        assert_eq!(text.contains("phase: processing"), terminal);
        assert_eq!(text.contains('\x1b'), terminal);
        let mut reused = Vec::new();
        let pool = embedding::pool::Pool::new(vec![()], |_, _| {
            anyhow::bail!("reused embeddings recomputed")
        })
        .unwrap();
        run_parallel_test(
            dir.path(),
            || Ok(Embedder::new(AsyncBackend { pool, limit: 2 })),
            &mut Vec::new(),
            &mut reused,
            terminal,
            &|| Duration::ZERO,
            &Profiler::default(),
        )
        .unwrap();
        let text = String::from_utf8(reused).unwrap();
        assert!(
            text.contains("phase: reused\nfile: a.rs\nfile_progress: not applicable"),
            "{text}"
        );
    }
}

#[test]
fn complete_processor_preserves_source_success_when_relationship_publication_fails() {
    use crate::processor::{Outcome, Request, Session};
    let dir = project(&[("start.rs", "pub fn start() {}\n")]);
    let root = dir.path().canonicalize().unwrap();
    let graph = root.join(".mimirs/watch/relationships.json");
    fs::create_dir_all(&graph).unwrap();
    let options = crate::knowledge::observation::Options {
        root: root.clone(),
        ..Default::default()
    };
    let mut log = Vec::new();
    let mut progress = Progress::new(&root, &mut log, false, &|| Duration::ZERO)
        .with_status(crate::status::Activity::start(&root, "index", "source"));
    let pool = embedding::pool::Pool::new(vec![()], |_, text| Ok(fake_vector(text))).unwrap();
    let mut session = Session::default();
    let request = || Request {
        root: &root,
        knowledge: &options,
        force: false,
    };
    let result = session
        .process(
            request(),
            || Ok(Embedder::new(AsyncBackend { pool, limit: 1 })),
            crate::analysis::extract,
            &mut progress,
        )
        .unwrap();
    assert!(!result.errors.is_empty());
    assert_eq!(result.indexed, 1);
    for name in ["source", "analysis", "retrieval", "embeddings", "storage"] {
        assert!(
            matches!(result.components[name], Outcome::Complete { .. }),
            "{name}: {result:?}"
        );
    }
    assert!(matches!(
        result.components["relationships"],
        Outcome::Incomplete { .. }
    ));
    let state: serde_json::Value =
        serde_json::from_slice(&fs::read(root.join(".mimirs/watch/state.json")).unwrap()).unwrap();
    assert_eq!(state["source"], "current");
    let db = storage::open(&root.join(".mimirs/index.db"))
        .unwrap()
        .connection;
    assert_eq!(
        crate::index::update::indexed_paths(&db).unwrap(),
        ["start.rs"]
    );
    storage::audit(&db).unwrap();
    drop(db);
    fs::remove_dir(&graph).unwrap();
    let retry = session
        .process(
            request(),
            || anyhow::bail!("warm model lost"),
            crate::analysis::extract,
            &mut progress,
        )
        .unwrap();
    assert!(retry.errors.is_empty(), "{retry:?}");
    assert!(retry.graph_published);
    assert_eq!(retry.embedded_documents, 0);
    assert_eq!(retry.indexed, 0);
    let snapshot: serde_json::Value =
        serde_json::from_slice(&fs::read(root.join(".mimirs/status.json")).unwrap()).unwrap();
    let activities = snapshot["activities"].as_object().unwrap();
    assert_eq!(activities.len(), 1);
    for activity in activities.values() {
        assert_eq!(activity["operation"], "index");
        assert_ne!(activity["phase"], "watching");
    }
    assert!(!snapshot.to_string().contains("watch-source"));
    assert!(!snapshot.to_string().contains("watch-knowledge"));
}

#[test]
fn complete_processor_model_failure_leaves_unstarted_phases_not_run() {
    use crate::processor::{Outcome, Request, Session};
    let dir = project(&[("start.rs", "pub fn start() {}\n")]);
    let root = dir.path().canonicalize().unwrap();
    let options = crate::knowledge::observation::Options {
        root: root.clone(),
        ..Default::default()
    };
    let mut log = Vec::new();
    let mut progress = Progress::new(&root, &mut log, false, &|| Duration::ZERO);
    let result = Session::default()
        .process(
            Request {
                root: &root,
                knowledge: &options,
                force: true,
            },
            || anyhow::bail!("model unavailable"),
            |_| panic!("analysis before model preparation"),
            &mut progress,
        )
        .unwrap();
    assert!(matches!(
        result.components["source"],
        Outcome::Complete { items: Some(1) }
    ));
    assert!(matches!(
        result.components["embeddings"],
        Outcome::Incomplete { completed: 0, .. }
    ));
    for name in ["analysis", "retrieval", "storage", "relationships"] {
        assert!(
            matches!(result.components[name], Outcome::NotRun),
            "{name}: {result:?}"
        );
    }
    assert_eq!(result.indexed, 0);
    let db = storage::open(&root.join(".mimirs/index.db"))
        .unwrap()
        .connection;
    assert!(crate::index::update::indexed_paths(&db).unwrap().is_empty());
}

#[test]
fn complete_processor_publishes_diagnostic_source_and_later_files_then_reuses_them() {
    use crate::processor::{Outcome, Request, Session};
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    let malformed = "pub fn intact() {}\npub fn editing( {\n";
    let valid = "pub fn unrelated() {}\n";
    let dir = project(&[("a.rs", malformed), ("b.rs", valid)]);
    let root = dir.path().canonicalize().unwrap();
    let options = crate::knowledge::observation::Options {
        root: root.clone(),
        ..Default::default()
    };
    let calls = Arc::new(AtomicUsize::new(0));
    let counted = calls.clone();
    let pool = embedding::pool::Pool::new(vec![(); 2], move |_, text| {
        counted.fetch_add(1, Ordering::Relaxed);
        Ok(fake_vector(text))
    })
    .unwrap();
    let mut log = Vec::new();
    let mut progress = Progress::new(&root, &mut log, false, &|| Duration::ZERO);
    let request = || Request {
        root: &root,
        knowledge: &options,
        force: false,
    };
    let mut session = Session::default();
    let first = session
        .process(
            request(),
            || Ok(Embedder::new(AsyncBackend { pool, limit: 2 })),
            crate::analysis::extract,
            &mut progress,
        )
        .unwrap();
    assert_eq!(first.indexed, 2, "{first:?}");
    for name in ["source", "analysis", "retrieval", "embeddings", "storage"] {
        assert!(
            matches!(first.components[name], Outcome::Complete { .. }),
            "{name}: {first:?}"
        );
    }
    assert!(matches!(
        first.components["relationships"],
        Outcome::Incomplete { .. }
    ));
    assert!(first.errors.is_empty());
    assert!(first.warnings.parser_diagnostics > 0);
    assert!(!first.graph_published);
    assert!(!root.join(".mimirs/watch/relationships.json").exists());
    let state: serde_json::Value =
        serde_json::from_slice(&fs::read(root.join(".mimirs/watch/state.json")).unwrap()).unwrap();
    assert_eq!(state["source"], "current");
    let db = storage::open(&root.join(".mimirs/index.db"))
        .unwrap()
        .connection;
    assert_eq!(
        crate::index::update::indexed_paths(&db).unwrap(),
        ["a.rs", "b.rs"]
    );
    let policy = storage::policy::read(&db).unwrap().unwrap();
    for (path, text) in [("a.rs", malformed), ("b.rs", valid)] {
        let saved = storage::analysis::load(&db, path).unwrap().unwrap();
        assert_eq!(saved.source.text, text);
        assert_eq!(!saved.diagnostics.is_empty(), path == "a.rs");
        assert!(
            !storage::documents::load(&db, path, &policy)
                .unwrap()
                .is_empty()
        );
    }
    storage::audit(&db).unwrap();
    drop(db);
    let before = calls.load(Ordering::Relaxed);
    assert!(before > 0);
    let retry = session
        .process(
            request(),
            || anyhow::bail!("warm model lost"),
            crate::analysis::extract,
            &mut progress,
        )
        .unwrap();
    assert_eq!(retry.unchanged, 2);
    assert_eq!(retry.indexed, 0);
    assert_eq!(retry.analyzed, 0);
    assert_eq!(retry.embedded_documents, 0);
    assert_eq!(calls.load(Ordering::Relaxed), before);
    for name in ["analysis", "retrieval", "embeddings", "storage"] {
        assert!(
            matches!(retry.components[name], Outcome::Unchanged),
            "{retry:?}"
        );
    }
    assert!(matches!(
        retry.components["relationships"],
        Outcome::Incomplete { .. }
    ));
    fs::write(
        root.join("a.rs"),
        "pub fn intact() {}\npub fn editing() {}\n",
    )
    .unwrap();
    let repaired = session
        .process(
            request(),
            || anyhow::bail!("warm model lost"),
            crate::analysis::extract,
            &mut progress,
        )
        .unwrap();
    assert!(repaired.errors.is_empty(), "{repaired:?}");
    assert_eq!(repaired.indexed, 1);
    assert_eq!(repaired.unchanged, 1);
    assert!(repaired.graph_published);
    assert!(crate::index::graph::read(&root).is_ok());
    drop(progress);
    assert!(!String::from_utf8(log).unwrap().contains("syntax: a.rs:"));
}

#[test]
fn best_effort_command_keeps_later_source_and_bounds_warnings_in_both_outputs() {
    for terminal in [false, true] {
        let malformed: String = (0..40)
            .map(|n| format!("pub fn editing_{n}() {{ let = ; }}\n"))
            .collect();
        let dir = project(&[("a.rs", &malformed), ("z.rs", "pub fn later() {}\n")]);
        fs::write(dir.path().join("middle.css"), [0xff, 0xfe]).unwrap();
        let root = dir.path().canonicalize().unwrap();
        let pool =
            embedding::pool::Pool::new(vec![(); 2], |_, text| Ok(fake_vector(text))).unwrap();
        let mut log = Vec::new();
        let mut output = Vec::new();
        let mut progress = Progress::new(&root, &mut log, terminal, &|| Duration::from_millis(1250))
            .with_status(crate::status::Activity::start(&root, "index", "source"));
        let report = crate::commands::index::execute(
            &root,
            || Ok(Embedder::new(AsyncBackend { pool, limit: 2 })),
            &mut progress,
            &mut output,
        )
        .unwrap();
        assert_eq!(report.indexed, 2);
        assert_eq!(report.warnings.unsupported_encoding_files, 1);
        assert!(report.warnings.parser_diagnostics >= 40);
        assert!(report.errors.is_empty());
        assert!(matches!(
            report.components["relationships"],
            crate::processor::Outcome::Incomplete { .. }
        ));
        drop(progress);
        let text = String::from_utf8(output).unwrap();
        assert!(text.contains("result: complete with warnings"), "{text}");
        assert!(text.ends_with("time: 1.25 seconds\n"), "{text}");
        assert!(text.contains("skipped: 1 unsupported-encoding files"));
        assert!(text.contains("relationships: incomplete"));
        assert!(text.contains(crate::index::diagnostics::PATH));
        assert!(!text.contains("processing: {"));
        assert!(text.len() < 1000);
        assert!(!String::from_utf8_lossy(&log).contains("syntax:"));
        if terminal {
            for frame in String::from_utf8_lossy(&log).split("\x1b[?7l").skip(1) {
                assert!(frame.split("\x1b[?7h").next().unwrap().lines().count() <= 6);
            }
        }
        if !terminal {
            assert!(String::from_utf8_lossy(&log).contains("indexing: 3 selected files"));
            assert!(log.len() < 100);
        }
        let db = storage::open_read_only(&root.join(".mimirs/index.db")).unwrap();
        assert_eq!(
            crate::index::update::indexed_paths(&db).unwrap(),
            ["a.rs", "z.rs"]
        );
        assert_eq!(
            storage::analysis::load(&db, "a.rs")
                .unwrap()
                .unwrap()
                .source
                .text,
            malformed
        );
        storage::audit(&db).unwrap();
        let status: serde_json::Value =
            serde_json::from_slice(&fs::read(root.join(".mimirs/status.json")).unwrap()).unwrap();
        assert_eq!(status["last_success"]["operation"], "index");
        assert_eq!(
            status["components"]["relationships"]["status"],
            "incomplete"
        );
        assert_eq!(status["components"]["source"]["status"], "partial");
        let details_path = root.join(crate::index::diagnostics::PATH);
        let details: serde_json::Value =
            serde_json::from_slice(&fs::read(&details_path).unwrap()).unwrap();
        assert_eq!(
            details["counts"]["parser_diagnostics"],
            report.warnings.parser_diagnostics
        );
        assert_eq!(details["coverage"], "observed_selection");
        assert!(
            details["entries"]
                .as_array()
                .unwrap()
                .iter()
                .any(|e| e["path"] == "middle.css" && e["kind"] == "unsupported_encoding")
        );
        let (scan, _) = crate::index::scan::Scan::capture(&root, true, None).unwrap();
        assert!(!scan.files.contains_key(crate::index::diagnostics::PATH));
        let mut capped = crate::index::diagnostics::Counts::default();
        crate::index::diagnostics::publish_with_limit(&root, &db, &scan, &[], 3, &mut capped)
            .unwrap();
        assert_eq!(
            capped.parser_diagnostics,
            report.warnings.parser_diagnostics
        );
        assert_eq!(capped.omitted_details, capped.parser_diagnostics + 1 - 3);
        let details: serde_json::Value =
            serde_json::from_slice(&fs::read(details_path).unwrap()).unwrap();
        assert_eq!(details["entries"].as_array().unwrap().len(), 3);
        assert_eq!(details["counts"]["omitted_details"], capped.omitted_details);
    }
}

#[test]
fn best_effort_command_keeps_true_failures_actionable() {
    let dir = project(&[("a.rs", "pub fn first() {}\n")]);
    let root = dir.path().canonicalize().unwrap();
    let mut log = Vec::new();
    let mut output = Vec::new();
    let mut progress = Progress::new(&root, &mut log, false, &|| Duration::ZERO);
    let result = crate::commands::index::execute(
        &root,
        || anyhow::bail!("injected model failure"),
        &mut progress,
        &mut output,
    );
    assert!(
        result
            .unwrap_err()
            .to_string()
            .contains("injected model failure")
    );
    let text = String::from_utf8(output).unwrap();
    assert!(text.contains("result: failed"), "{text}");
    assert!(text.contains("injected model failure"));
    assert!(!text.contains("processing: {"));
    let db = storage::open_read_only(&root.join(".mimirs/index.db")).unwrap();
    assert!(crate::index::update::indexed_paths(&db).unwrap().is_empty());
}

#[test]
fn best_effort_keeps_permission_and_diagnostic_persistence_failures_fatal() {
    for blocked_details in [false, true] {
        let dir = project(&[
            ("a.rs", "pub fn first() {}\n"),
            ("middle.rs", "pub fn middle() {}\n"),
            ("z.rs", "pub fn last() {}\n"),
        ]);
        let root = dir.path().canonicalize().unwrap();
        if blocked_details {
            fs::create_dir_all(root.join(crate::index::diagnostics::PATH)).unwrap();
        } else {
            fs::set_permissions(root.join("middle.rs"), fs::Permissions::from_mode(0o000)).unwrap();
        }
        let pool = embedding::pool::Pool::new(vec![()], |_, text| Ok(fake_vector(text))).unwrap();
        let mut log = Vec::new();
        let mut output = Vec::new();
        let mut progress = Progress::new(&root, &mut log, false, &|| Duration::ZERO);
        let error = crate::commands::index::execute(
            &root,
            || Ok(Embedder::new(AsyncBackend { pool, limit: 1 })),
            &mut progress,
            &mut output,
        )
        .unwrap_err();
        let text = String::from_utf8(output).unwrap();
        assert!(text.contains("result: failed"), "{text}");
        let db = storage::open_read_only(&root.join(".mimirs/index.db")).unwrap();
        let paths = crate::index::update::indexed_paths(&db).unwrap();
        assert!(paths.contains(&"a.rs".into()) && paths.contains(&"z.rs".into()));
        storage::audit(&db).unwrap();
        if blocked_details {
            assert!(
                error
                    .to_string()
                    .contains("cannot save processing diagnostics")
            );
            assert!(crate::index::graph::read(&root).is_ok());
        } else {
            assert!(error.to_string().contains("middle.rs"));
            assert!(text.contains("read failures: 1 files"));
            assert!(!paths.contains(&"middle.rs".into()));
            let details: serde_json::Value = serde_json::from_slice(
                &fs::read(root.join(crate::index::diagnostics::PATH)).unwrap(),
            )
            .unwrap();
            assert_eq!(details["counts"]["unsupported_encoding_files"], 0);
            assert_eq!(details["counts"]["read_failures"], 1);
            assert_eq!(details["coverage"], "incomplete_processing");
            fs::set_permissions(root.join("middle.rs"), fs::Permissions::from_mode(0o644)).unwrap();
        }
    }
}

#[test]
fn best_effort_graph_retirement_failure_does_not_hide_source_success() {
    let dir = project(&[
        ("a.rs", "pub fn editing() { let = ; }\n"),
        ("z.rs", "pub fn later() {}\n"),
    ]);
    let root = dir.path().canonicalize().unwrap();
    fs::create_dir_all(root.join(".mimirs/watch/relationships.json")).unwrap();
    let options = crate::knowledge::observation::Options {
        root: root.clone(),
        ..Default::default()
    };
    let mut log = Vec::new();
    let mut progress = Progress::new(&root, &mut log, false, &|| Duration::ZERO);
    let pool = embedding::pool::Pool::new(vec![()], |_, text| Ok(fake_vector(text))).unwrap();
    let result = crate::processor::Session::default()
        .process(
            crate::processor::Request {
                root: &root,
                knowledge: &options,
                force: true,
            },
            || Ok(Embedder::new(AsyncBackend { pool, limit: 1 })),
            crate::analysis::extract,
            &mut progress,
        )
        .unwrap();
    assert_eq!(result.indexed, 2);
    assert_eq!(result.errors.len(), 1, "{result:?}");
    assert!(result.errors[0].contains("cannot retire relationship cache"));
    assert!(result.warnings.parser_diagnostics > 0);
    assert!(matches!(
        result.components["storage"],
        crate::processor::Outcome::Complete { .. }
    ));
    let db = storage::open_read_only(&root.join(".mimirs/index.db")).unwrap();
    assert_eq!(
        crate::index::update::indexed_paths(&db).unwrap(),
        ["a.rs", "z.rs"]
    );
}

#[derive(Clone, Default)]
struct LiveCapture(std::sync::Arc<(std::sync::Mutex<Vec<u8>>, std::sync::Condvar)>);
impl std::io::Write for LiveCapture {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.0.lock().unwrap().extend_from_slice(bytes);
        self.0.1.notify_all();
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
impl LiveCapture {
    fn text(&self) -> String {
        String::from_utf8(self.0.0.lock().unwrap().clone()).unwrap()
    }
    fn wait_elapsed(&self, phase: &str, seconds: f64) {
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut bytes = self.0.0.lock().unwrap();
        loop {
            let text = String::from_utf8_lossy(&bytes);
            let ready = text.split("\x1b[?7l").any(|frame| {
                frame.contains(&format!("phase: {phase}\n"))
                    && frame.lines().any(|line| {
                        line.strip_prefix("elapsed_time: ")
                            .and_then(|s| s.split_whitespace().next())
                            .and_then(|s| s.parse::<f64>().ok())
                            .is_some_and(|n| n >= seconds)
                    })
            });
            if ready {
                return;
            }
            let left = deadline.saturating_duration_since(Instant::now());
            assert!(
                !left.is_zero(),
                "no heartbeat for {phase} at {seconds}: {text}"
            );
            bytes = self.0.1.wait_timeout(bytes, left).unwrap().0;
        }
    }
}

#[test]
fn live_progress_production_keeps_updating_after_32_events_and_during_model_wait() {
    let dir = project(&[]);
    for n in 0..40 {
        fs::write(
            dir.path().join(format!("f{n:02}.rs")),
            format!("pub fn item_{n}() {{}}\n"),
        )
        .unwrap();
    }
    let root = dir.path().canonicalize().unwrap();
    let capture = LiveCapture::default();
    let mut writer = capture.clone();
    let start = Instant::now();
    let pool = embedding::pool::Pool::new(vec![()], |_, text| Ok(fake_vector(text))).unwrap();
    let mut output = Vec::new();
    let report =
        crate::index::progress::live(&root, &mut writer, true, &|| start.elapsed(), |progress| {
            crate::commands::index::execute(
                &root,
                || {
                    let before = capture.text();
                    let frame = before.rsplit("\x1b[?7l").next().unwrap();
                    assert!(frame.contains("phase: preparing model\n"));
                    assert!(!frame.contains("file_progress:"));
                    assert!(before.matches("\x1b[?7l").count() > 32);
                    capture.wait_elapsed("preparing model", start.elapsed().as_secs_f64() + 0.9);
                    Ok(Embedder::new(AsyncBackend { pool, limit: 1 }))
                },
                progress,
                &mut output,
            )
        })
        .unwrap();
    assert_eq!(report.indexed, 40);
    let text = capture.text();
    assert!(text.matches("\x1b[?7l").count() > 100);
    assert!(text.contains("file: f39.rs"));
    assert!(text.contains("phase: finalizing\n"));
    assert!(text.contains("40/40 files"));
    let elapsed: Vec<f64> = text
        .lines()
        .filter_map(|line| line.strip_prefix("elapsed_time: "))
        .map(|value| value.split_whitespace().next().unwrap().parse().unwrap())
        .collect();
    assert!(elapsed.windows(2).all(|pair| pair[0] <= pair[1]));
    assert!(text.ends_with("\x1b[?7h"));
    assert!(
        String::from_utf8(output)
            .unwrap()
            .contains("result: complete")
    );
    let finished = capture.text();
    std::thread::sleep(Duration::from_millis(1100));
    assert_eq!(capture.text(), finished, "post-completion redraw");
}

#[test]
fn live_progress_silence_preserves_counts_without_status_writes_and_stops_on_error() {
    let dir = project(&[]);
    let path = dir.path().join(".mimirs/status.json");
    fs::write(&path, "unchanged diagnostic snapshot").unwrap();
    let modified = fs::metadata(&path).unwrap().modified().unwrap();
    let capture = LiveCapture::default();
    let mut writer = capture.clone();
    let start = Instant::now();
    let result: anyhow::Result<()> = crate::index::progress::live(
        dir.path(),
        &mut writer,
        true,
        &|| start.elapsed(),
        |progress| {
            progress.concise();
            progress.file(
                "waiting.rs",
                crate::index::progress::Work::Known { done: 2, total: 9 },
                (7, 12),
                crate::index::progress::FileOutcome::Processing,
            )?;
            capture.wait_elapsed("processing", 0.9);
            let text = capture.text();
            assert!(text.matches("file_progress: 22% (2/9 documents)").count() >= 2);
            assert!(text.matches("files_completed: 58% (7/12 files)").count() >= 2);
            assert_eq!(fs::read(&path).unwrap(), b"unchanged diagnostic snapshot");
            assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), modified);
            progress.phase("finalizing", "source", None)?;
            let text = capture.text();
            let latest = text.rsplit("\x1b[?7l").next().unwrap();
            assert!(latest.contains("phase: finalizing\nfile: -\n"));
            assert!(!latest.contains("file_progress:"));
            anyhow::bail!("injected cancellation")
        },
    );
    assert!(
        result
            .unwrap_err()
            .to_string()
            .contains("injected cancellation")
    );
    let finished = capture.text();
    std::thread::sleep(Duration::from_millis(1100));
    assert_eq!(capture.text(), finished);
    assert!(finished.ends_with("\x1b[?7h"));
}

#[test]
fn live_progress_redirected_waits_do_not_produce_timer_output() {
    let dir = project(&[]);
    let mut output = Vec::new();
    let start = Instant::now();
    crate::index::progress::live(
        dir.path(),
        &mut output,
        false,
        &|| start.elapsed(),
        |progress| {
            progress.concise();
            progress.walking("-", 40)?;
            for done in 0..40 {
                progress.file(
                    "a.rs",
                    crate::index::progress::Work::Known { done, total: 40 },
                    (0, 1),
                    crate::index::progress::FileOutcome::Processing,
                )?;
            }
            progress.phase("preparing model", "vectors_model", None)?;
            std::thread::sleep(Duration::from_millis(1100));
            Ok(())
        },
    )
    .unwrap();
    assert_eq!(
        String::from_utf8(output).unwrap(),
        "indexing: 40 selected files\n"
    );
}

struct LiveFailure {
    capture: LiveCapture,
    fail: std::sync::Arc<std::sync::atomic::AtomicBool>,
    failed: std::sync::Arc<(std::sync::Mutex<bool>, std::sync::Condvar)>,
    processing_until_failure: Option<usize>,
}
impl std::io::Write for LiveFailure {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        use std::sync::atomic::Ordering;
        if String::from_utf8_lossy(bytes).contains("phase: processing\n")
            && let Some(left) = &mut self.processing_until_failure
        {
            *left -= 1;
            if *left == 0 {
                self.fail.store(true, Ordering::SeqCst);
            }
        }
        if self.fail.load(Ordering::SeqCst) && bytes != b"\x1b[?7h" {
            *self.failed.0.lock().unwrap() = true;
            self.failed.1.notify_all();
            return Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "injected terminal failure",
            ));
        }
        std::io::Write::write(&mut self.capture, bytes)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[test]
fn live_progress_timer_failure_propagates_and_restores_terminal_without_waiting_for_next_tick() {
    use std::sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, Ordering},
    };
    let capture = LiveCapture::default();
    let fail = Arc::new(AtomicBool::new(false));
    let failed = Arc::new((Mutex::new(false), Condvar::new()));
    let mut writer = LiveFailure {
        capture: capture.clone(),
        fail: fail.clone(),
        failed: failed.clone(),
        processing_until_failure: None,
    };
    let start = Instant::now();
    let mut work_done = None;
    let result = crate::index::progress::live(
        Path::new("root"),
        &mut writer,
        true,
        &|| start.elapsed(),
        |progress| {
            progress.phase("preparing model", "vectors_model", None)?;
            fail.store(true, Ordering::SeqCst);
            let (seen, timed) = failed
                .1
                .wait_timeout_while(failed.0.lock().unwrap(), Duration::from_secs(5), |seen| {
                    !*seen
                })
                .unwrap();
            assert!(
                *seen && !timed.timed_out(),
                "timer never attempted a redraw"
            );
            work_done = Some(Instant::now());
            Ok(())
        },
    );
    assert!(
        result
            .unwrap_err()
            .to_string()
            .contains("injected terminal failure")
    );
    assert!(work_done.unwrap().elapsed() < Duration::from_secs(1));
    assert!(capture.text().ends_with("\x1b[?7h"));
    let finished = capture.text();
    std::thread::sleep(Duration::from_millis(1100));
    assert_eq!(capture.text(), finished);
}

#[test]
fn live_progress_output_failure_cancels_production_workers_and_releases_writer() {
    use std::sync::{Arc, Condvar, Mutex, atomic::AtomicBool};
    let dir = project(&[]);
    for n in 0..40 {
        fs::write(
            dir.path().join(format!("f{n:02}.rs")),
            format!("pub fn item_{n}() {{}}\n"),
        )
        .unwrap();
    }
    let root = dir.path().canonicalize().unwrap();
    let capture = LiveCapture::default();
    let mut writer = LiveFailure {
        capture: capture.clone(),
        fail: Arc::new(AtomicBool::new(false)),
        failed: Arc::new((Mutex::new(false), Condvar::new())),
        processing_until_failure: Some(10),
    };
    let pool = embedding::pool::Pool::new(vec![(); 2], |_, text| Ok(fake_vector(text))).unwrap();
    let start = Instant::now();
    let result =
        crate::index::progress::live(&root, &mut writer, true, &|| start.elapsed(), |progress| {
            crate::commands::index::execute(
                &root,
                || Ok(Embedder::new(AsyncBackend { pool, limit: 2 })),
                progress,
                &mut Vec::new(),
            )
        });
    assert!(result.is_err());
    let _writer = crate::storage::writer::acquire(&root).unwrap();
    let db = storage::open_read_only(&root.join(".mimirs/index.db")).unwrap();
    storage::audit(&db).unwrap();
    assert!(!root.join(".mimirs/watch/relationships.json").exists());
    assert!(capture.text().ends_with("\x1b[?7h"));
}

#[test]
fn live_progress_unwind_stops_the_scoped_timer() {
    let capture = LiveCapture::default();
    let mut output = capture.clone();
    let start = Instant::now();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _: anyhow::Result<()> = crate::index::progress::live(
            Path::new("root"),
            &mut output,
            true,
            &|| start.elapsed(),
            |progress| {
                progress.phase("discovering source", "source", None)?;
                panic!("injected processing panic");
            },
        );
    }));
    assert!(result.is_err());
    assert!(start.elapsed() < Duration::from_secs(1));
    assert!(capture.text().ends_with("\x1b[?7h"));
}

#[test]
fn live_progress_status_diagnostics_share_the_terminal_and_survive_redraw() {
    let dir = project(&[]);
    let mut activity = crate::status::Activity::start(dir.path(), "index", "source");
    activity.defer_warnings();
    let capture = LiveCapture::default();
    let mut writer = capture.clone();
    crate::index::progress::live(
        dir.path(),
        &mut writer,
        true,
        &|| Duration::ZERO,
        |progress| {
            progress.status = Some(activity);
            progress.phase("preparing model", "source", None)?;
            fs::write(
                dir.path().join(".mimirs/status.json"),
                b"invalid status JSON",
            )?;
            progress
                .status
                .as_ref()
                .unwrap()
                .observe("source", "observed", "fixture");
            assert!(!capture.text().contains("status diagnostic:"));
            progress.phase("finalizing", "source", None)?;
            let text = capture.text();
            let diagnostic = text.find("status diagnostic:").unwrap();
            let frame = text.rfind("\x1b[?7l").unwrap();
            assert!(diagnostic < frame);
            assert!(
                !text[diagnostic..frame].contains("\x1b[J"),
                "diagnostic was erased"
            );
            assert!(text[frame..].contains("phase: finalizing"));
            progress
                .status
                .as_mut()
                .unwrap()
                .finish("success", None, None, None);
            progress.clear()?;
            Ok(())
        },
    )
    .unwrap();
    assert!(capture.text().ends_with("\x1b[?7h"));
}
