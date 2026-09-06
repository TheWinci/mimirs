use std::{fs, process::Command};

#[test]
fn inspection_needs_no_project_and_does_not_write() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("file.rs"), "fn (").unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_mimirs"))
        .args(["inspect", "file.rs"])
        .current_dir(&dir)
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(String::from_utf8_lossy(&output.stdout).contains("parse: incomplete"));
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    assert_eq!(
        fs::read_to_string(dir.path().join("file.rs")).unwrap(),
        "fn ("
    );
    for file in ["missing.rs", "file.txt", "invalid.rs"] {
        fs::write(dir.path().join("invalid.rs"), [255]).unwrap();
        let output = Command::new(env!("CARGO_BIN_EXE_mimirs"))
            .args(["inspect", file])
            .current_dir(&dir)
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains(file));
        assert!(output.stdout.is_empty());
    }
}

#[test]
fn stored_cli_reports_missing_index_without_creating_state() {
    let dir = tempfile::tempdir().unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_mimirs"))
        .args(["inspect", "deleted.rs", "--stored"])
        .current_dir(&dir)
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&output.stderr).contains("index is missing"));
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
}

#[test]
fn source_chunk_preview_preserves_code_without_a_model_or_project() {
    let dir = tempfile::tempdir().unwrap();
    let source = "/// Reject newlines.\nfn valid(name: &str) -> bool { !name.ends_with('\\n') }";
    fs::write(dir.path().join("file.rs"), source).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_mimirs"))
        .args(["inspect", "file.rs", "--source-chunks"])
        .current_dir(&dir)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let chunks: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(chunks[0]["text"], source);
    assert_eq!(chunks[0]["context"], "file.rs");
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    let conflict = Command::new(env!("CARGO_BIN_EXE_mimirs"))
        .args(["inspect", "file.rs", "--source-chunks", "--documents"])
        .current_dir(&dir)
        .output()
        .unwrap();
    assert!(!conflict.status.success());
}

#[test]
fn python_and_stubs_preview_decorated_methods_without_project_state() {
    let dir = tempfile::tempdir().unwrap();
    let source = "class Café:\n    @classmethod\n    def make(cls): ...\n";
    for path in ["example.py", "example.pyi"] {
        fs::write(dir.path().join(path), source).unwrap();
        let output = Command::new(env!("CARGO_BIN_EXE_mimirs"))
            .args(["inspect", path, "--source-chunks"])
            .current_dir(&dir)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let chunks: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        let method = chunks
            .as_array()
            .unwrap()
            .iter()
            .find(|chunk| chunk["owner"] == 1)
            .unwrap();
        assert_eq!(method["text"], "@classmethod\n    def make(cls): ...");
        assert_eq!(method["context"], format!("{path} :: class Café"));
        let report = Command::new(env!("CARGO_BIN_EXE_mimirs"))
            .args(["inspect", path])
            .current_dir(&dir)
            .output()
            .unwrap();
        assert!(report.status.success());
        assert!(String::from_utf8_lossy(&report.stdout).contains("parse: complete"));
    }
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 2);
}
