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
