use serde_json::Value;
use std::{fs, process::Command};

#[test]
fn context_cli_off_overrides_preferences_without_knowledge_setup() {
    let temp = tempfile::tempdir().unwrap();
    fs::create_dir(temp.path().join(".mimirs")).unwrap();
    fs::write(
        temp.path().join(".mimirs/config.toml"),
        "[context]\nknowledge = 'off'\n",
    )
    .unwrap();
    let run = |extra: &[&str]| {
        let output = Command::new(env!("CARGO_BIN_EXE_mimirs"))
            .args(["context", "task", "--root"])
            .arg(temp.path())
            .args(extra)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(output.stdout.len() <= 16000);
        serde_json::from_slice::<Value>(&output.stdout).unwrap()
    };
    assert_eq!(run(&[])["knowledge"]["status"], "disabled");
    assert_eq!(
        run(&["--knowledge", "auto"])["knowledge"]["status"],
        "not_configured"
    );
    assert_eq!(
        run(&["--knowledge", "off"])["knowledge"]["status"],
        "disabled"
    );
    assert!(!temp.path().join(".mimirs/knowledge").exists());
}

#[test]
fn context_cli_returns_knowledge_on_source_failure_and_preserves_journal() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("source");
    fs::create_dir(&root).unwrap();
    let git = |args: &[&str]| {
        let out = Command::new("git")
            .arg("-C")
            .arg(&root)
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
    };
    git(&["init", "-b", "main"]);
    fs::write(root.join("reader.rs"), "fn read_bytes() {}\n").unwrap();
    git(&["add", "."]);
    git(&[
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-m",
        "fixture",
    ]);
    let state = temp.path().join("state");
    let binary = env!("CARGO_BIN_EXE_mimirs");
    let learned = Command::new(binary)
        .args(["knowledge", "--repository", "test/context", "--root"])
        .arg(&root)
        .arg("--state")
        .arg(&state)
        .args([
            "learn",
            "Read bytes without normalization",
            "--evidence",
            "reader.rs",
            "--actor",
            "reviewer",
        ])
        .output()
        .unwrap();
    assert!(learned.status.success());
    let segment = fs::read_dir(state.join("repositories"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path()
        .join("events");
    let bytes = || {
        fs::read_dir(&segment)
            .unwrap()
            .map(|p| fs::read(p.unwrap().path()).unwrap())
            .collect::<Vec<_>>()
    };
    let before = bytes();
    let output = Command::new(binary)
        .args([
            "context",
            "read bytes",
            "--repository",
            "test/context",
            "--root",
        ])
        .arg(&root)
        .arg("--state")
        .arg(&state)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stdout.len() <= 16000);
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["source"]["retrieval"], "failed");
    assert_eq!(
        value["knowledge"]["items"][0]["statement"],
        "Read bytes without normalization"
    );
    assert_eq!(before, bytes());
    let search_help = Command::new(binary)
        .args(["search", "--help"])
        .output()
        .unwrap();
    let help = String::from_utf8(search_help.stdout).unwrap();
    assert!(help.contains("--output"));
    assert!(help.contains("full, compact"));
    let tiny = Command::new(binary)
        .args(["context", "read", "--max-bytes", "100"])
        .output()
        .unwrap();
    assert!(!tiny.status.success());
    assert!(tiny.stdout.is_empty());
}
