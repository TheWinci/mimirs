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
    connection(dir).prepare("SELECT f.path, c.text FROM files f JOIN chunks c ON c.file_id = f.id ORDER BY f.path, c.ordinal")
        .unwrap().query_map([], |row| Ok((row.get(0)?, row.get(1)?))).unwrap()
        .collect::<rusqlite::Result<_>>().unwrap()
}

fn counts(dir: &TempDir) -> Vec<i64> {
    let db = connection(dir);
    [
        "files",
        "chunks",
        "windows",
        "window_embeddings",
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
        "indexed: 2 files\nskipped: 0 files\nwalk_errors: 0\ntime: 1.25 seconds\n"
    );
    assert_eq!(stderr, include_str!("../../goldens/index/redirected.txt"));
    assert_eq!(calls.borrow().preparations, 1);
    assert_eq!(calls.borrow().batches, [vec!["first", "  second  "]]);
    assert_eq!(counts(&dir), [2, 2, 2, 2, 2]);
    let db = connection(&dir);
    let rows: Vec<(String, i64, i64, String, Vec<u8>)> = db
        .prepare(
            "SELECT f.path, c.ordinal, w.ordinal, w.text, e.embedding
         FROM files f JOIN chunks c ON c.file_id=f.id JOIN windows w ON w.chunk_id=c.id
         JOIN window_embeddings e ON e.window_id=w.id ORDER BY f.path, c.ordinal, w.ordinal",
        )
        .unwrap()
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        })
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(rows.len(), 2);
    for (ordinal, (path, chunk, window, text, vector)) in rows.iter().enumerate() {
        assert_eq!(path, "a.rs");
        assert_eq!(*chunk, 0);
        assert_eq!(*window, ordinal as i64);
        assert_eq!(vector.len(), DIMENSION * 4);
        assert_eq!(
            f32::from_ne_bytes(vector[..4].try_into().unwrap()),
            text.len() as f32
        );
    }
    run(&dir, backend(), false).0.unwrap();
    assert_eq!(counts(&dir), [2, 2, 2, 2, 2]);
}

#[test]
fn batches_update_only_terminal_progress() {
    let text = "line\n".repeat(257);
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
        assert_eq!(stderr.contains("100% (256/257 windows)"), terminal);
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
        "indexed: 0 files\nskipped: 1 files\nwalk_errors: 0\ntime: 1.25 seconds\n"
    );
    assert_eq!(stderr, include_str!("../../goldens/index/read_skip.txt"));
    assert_eq!(counts(&dir), [0, 0, 0, 0, 2]);
    fs::remove_file(dir.path().join("a.rs")).unwrap();
    let model = backend();
    let calls = Rc::clone(&model.calls);
    let (result, stdout, stderr) = run(&dir, model, false);
    result.unwrap();
    assert_eq!(
        stdout,
        "indexed: 0 files\nskipped: 0 files\nwalk_errors: 0\ntime: 1.25 seconds\n"
    );
    assert_eq!(stderr, include_str!("../../goldens/index/empty.txt"));
    assert_eq!(calls.borrow().preparations, 1);
    assert!(calls.borrow().batches.is_empty());
    assert_eq!(counts(&dir), [0, 0, 0, 0, 2]);
}

#[test]
fn fresh_empty_index_stays_unstamped() {
    let dir = project(&[]);
    run(&dir, backend(), false).0.unwrap();
    assert_eq!(counts(&dir), [0, 0, 0, 0, 0]);
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
    assert!(stdout.starts_with("indexed: 1 files\nskipped: 1 files"));
    assert!(stderr.contains("cannot read source file d.rs"));
    assert_eq!(files(&dir), [("a.rs".into(), "keep".into())]);
    assert_eq!(counts(&dir), [1, 1, 1, 1, 2]);
    fs::remove_file(dir.path().join("a.rs")).unwrap();
    fs::remove_file(dir.path().join("d.rs")).unwrap();
    run(&dir, backend(), false).0.unwrap();
    assert_eq!(counts(&dir), [0, 0, 0, 0, 2]);
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
    assert_eq!(counts(&dir), [1, 1, 1, 1, 2]);
}

#[test]
fn embedding_failure_preserves_earlier_commits_and_omits_cleanup() {
    let dir = project(&[("a.rs", "old a"), ("b.rs", "old b"), ("stale.rs", "stale")]);
    run(&dir, backend(), false).0.unwrap();
    fs::write(dir.path().join("a.rs"), "new a").unwrap();
    fs::write(dir.path().join("b.rs"), "fail").unwrap();
    fs::remove_file(dir.path().join("stale.rs")).unwrap();
    let mut model = backend();
    model.fail_on = Some("fail".into());
    let (result, stdout, stderr) = run(&dir, model, true);
    assert!(format!("{:#}", result.unwrap_err()).contains("cannot embed source file b.rs"));
    assert!(stdout.is_empty());
    assert!(stderr.ends_with("\x1b[6F\x1b[J"));
    assert_eq!(
        files(&dir),
        [
            ("a.rs".into(), "new a".into()),
            ("b.rs".into(), "old b".into()),
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
            let batch = b"256/257 windows";
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
    fs::write(dir.path().join("b.rs"), "line\n".repeat(257)).unwrap();
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
            ("b.rs".into(), "old b".into()),
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
    for (table, operation) in [("chunks", "INSERT"), ("files", "DELETE")] {
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
        let expected = if operation == "INSERT" { "old" } else { "new" };
        assert_eq!(
            files(&dir),
            [
                ("a.rs".into(), expected.into()),
                ("stale.rs".into(), "stale".into())
            ]
        );
        assert_eq!(counts(&dir), [2, 2, 2, 2, 2]);
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
    assert!(stdout.starts_with("indexed: 0 files\nskipped: 1 files\nwalk_errors: 0\n"));
    assert!(stderr.contains("cannot read source file a.rs"));
    assert!(stderr.contains("index_progress: 100% (1/1 files)"));
    assert_eq!(counts(&dir), [0, 0, 0, 0, 2]);
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
