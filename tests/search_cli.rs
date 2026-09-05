use std::process::Command;

use tempfile::TempDir;

#[test]
fn search_errors_use_stderr_and_nonzero_exit() {
    let dir = TempDir::new().unwrap();
    for (query, limit, error) in [
        (" ", "5", "query must not be blank"),
        ("query", "0", "limit must be between 1 and 4096"),
        ("query", "4097", "limit must be between 1 and 4096"),
        ("query", "5", "run mimirs init or mimirs index"),
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_mimirs"))
            .current_dir(dir.path())
            .args(["search", query, "--limit", limit])
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        assert!(String::from_utf8(output.stderr).unwrap().contains(error));
    }
    assert!(!dir.path().join(".mimirs").exists());
}

#[test]
fn search_help_keeps_the_default_limit() {
    let output = Command::new(env!("CARGO_BIN_EXE_mimirs"))
        .args(["search", "--help"])
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(
        String::from_utf8(output.stdout)
            .unwrap()
            .contains("[default: 5]")
    );
    assert!(output.stderr.is_empty());
}

#[test]
fn empty_search_prints_only_the_result_summary() {
    use rusqlite::auto_extension::{RawAutoExtension, register_auto_extension};
    unsafe {
        let entrypoint: RawAutoExtension =
            std::mem::transmute(sqlite_vec::sqlite3_vec_init as *const ());
        register_auto_extension(entrypoint).unwrap();
    }
    let dir = TempDir::new().unwrap();
    std::fs::create_dir(dir.path().join(".mimirs")).unwrap();
    let connection = rusqlite::Connection::open(dir.path().join(".mimirs/index.db")).unwrap();
    connection
        .execute_batch(include_str!("../src/storage/schema.sql"))
        .unwrap();
    connection.pragma_update(None, "user_version", 6).unwrap();
    drop(connection);
    let output = Command::new(env!("CARGO_BIN_EXE_mimirs"))
        .current_dir(dir.path())
        .args(["search", "query"])
        .output()
        .unwrap();
    assert!(output.status.success(), "{:?}", output.stderr);
    assert!(output.stderr.is_empty());
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(stdout.starts_with("results: 0\ntime: "));
    assert!(stdout.ends_with(" seconds\n"));
    assert_eq!(stdout.lines().count(), 2);
}
