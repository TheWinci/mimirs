use serde_json::Value;
use std::{
    fs,
    path::Path,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

fn git(root: &Path, args: &[&str]) {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
fn project() -> tempfile::TempDir {
    let t = tempfile::tempdir().unwrap();
    git(t.path(), &["init", "-b", "main"]);
    fs::write(
        t.path().join("evidence.txt"),
        "source content must not appear in status\n",
    )
    .unwrap();
    git(t.path(), &["add", "."]);
    git(
        t.path(),
        &[
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "-m",
            "fixture",
        ],
    );
    t
}
fn status(root: &Path) -> Value {
    let output = Command::new(env!("CARGO_BIN_EXE_mimirs"))
        .args(["status", "--json", "--root"])
        .arg(root)
        .output()
        .unwrap();
    assert!(output.status.success());
    serde_json::from_slice(&output.stdout).unwrap()
}
fn learn(root: &Path) -> Value {
    let output = Command::new(env!("CARGO_BIN_EXE_mimirs"))
        .args(["knowledge", "--repository", "test/status", "--root"])
        .arg(root)
        .args([
            "learn",
            "Evidence remains explicit",
            "--evidence",
            "evidence.txt",
            "--actor",
            "fixture",
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}
#[test]
fn status_before_setup_after_learning_and_when_unwritable_is_safe() {
    let t = project();
    assert_eq!(status(t.path())["snapshot"], "missing");
    assert!(!t.path().join(".mimirs").exists());
    let learned = learn(t.path());
    let view = status(t.path());
    assert_eq!(view["last_learned"]["claim"], learned["knowledge_id"]);
    assert!(
        !serde_json::to_string(&view)
            .unwrap()
            .contains("source content must not appear")
    );
    let before = fs::read(t.path().join(".mimirs/status.json")).unwrap();
    status(t.path());
    assert_eq!(
        before,
        fs::read(t.path().join(".mimirs/status.json")).unwrap()
    );
    fs::remove_file(t.path().join(".mimirs/status.json")).unwrap();
    fs::create_dir(t.path().join(".mimirs/status.json")).unwrap();
    assert!(learn(t.path())["knowledge_id"].is_string());
    assert_eq!(status(t.path())["snapshot"], "unavailable");
}
#[test]
fn learning_preserves_live_watch_identity_and_exit_invalidates_activity() {
    let t = project();
    fs::create_dir(t.path().join(".mimirs")).unwrap();
    fs::write(t.path().join(".mimirs/.gitignore"), "*\n").unwrap();
    fs::write(
        t.path().join(".mimirs/config.toml"),
        "include=['**/*.never']\n",
    )
    .unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_mimirs"))
        .args(["watch", "--root"])
        .arg(t.path())
        .args(["--interval-ms", "100", "--debounce-ms", "0"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    let before = loop {
        let view = status(t.path());
        if view["activities"]
            .as_object()
            .unwrap()
            .values()
            .any(|a| a["operation"] == "watch" && a["state"] == "observed_active")
        {
            break view;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(25));
    };
    let learned = learn(t.path());
    let after = status(t.path());
    let winner = before["activities"]
        .as_object()
        .unwrap()
        .values()
        .find(|a| a["operation"] == "watch")
        .unwrap()["id"]
        .as_str()
        .unwrap();
    assert_eq!(after["activities"][winner]["state"], "observed_active");
    assert_eq!(after["last_learned"]["claim"], learned["knowledge_id"]);
    child.kill().unwrap();
    child.wait().unwrap();
    assert_eq!(status(t.path())["activities"][winner]["state"], "stopped");
}

#[test]
fn learning_success_keeps_separate_historical_failures() {
    let t = project();
    let run = |name: &str| {
        Command::new(env!("CARGO_BIN_EXE_mimirs"))
            .args(["knowledge", "--repository", "test/status", "--root"])
            .arg(t.path())
            .args([
                "learn",
                &format!("Claim {name}"),
                "--evidence",
                &format!("{name}.rs"),
                "--actor",
                "fixture",
            ])
            .output()
            .unwrap()
    };
    assert!(!run("a").status.success());
    assert!(!run("b").status.success());
    let failures = status(t.path())["failures"].clone();
    assert_eq!(failures.as_array().unwrap().len(), 2);
    for name in ["b", "a"] {
        fs::write(t.path().join(format!("{name}.rs")), "fn support() {}\n").unwrap();
        git(t.path(), &["add", "."]);
        git(
            t.path(),
            &[
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "commit",
                "-m",
                "support",
            ],
        );
        let output = run(name);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let view = status(t.path());
        assert_eq!(view["failures"], failures);
        assert!(view["last_success"]["id"].is_string());
    }
}

#[test]
fn context_targets_keep_a_failures_historical_after_b_and_a_success() {
    let t = project();
    let a = t.path().join(".mimirs/knowledge");
    let b = t.path().join(".mimirs/other-knowledge");
    for (repo, state) in [("test/a", &a), ("test/b", &b)] {
        let out = Command::new(env!("CARGO_BIN_EXE_mimirs"))
            .args(["knowledge", "--root"])
            .arg(t.path())
            .args(["--repository", repo, "--state"])
            .arg(state)
            .args([
                "learn",
                "Evidence contract",
                "--evidence",
                "evidence.txt",
                "--actor",
                "fixture",
            ])
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
    let repo = fs::read_dir(a.join("repositories"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let journal = fs::read_dir(repo.join("events"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let saved = fs::read(&journal).unwrap();
    fs::write(&journal, "corrupt").unwrap();
    let context = |repo: &str, state: &Path, branch: &str, mode: &str| {
        let out = Command::new(env!("CARGO_BIN_EXE_mimirs"))
            .args(["context", "--output", "json", "evidence", "--root"])
            .arg(t.path())
            .args(["--repository", repo, "--state"])
            .arg(state)
            .args(["--default-branch", branch, "--knowledge", mode])
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        serde_json::from_slice::<Value>(&out.stdout).unwrap()
    };
    assert_eq!(
        context("test/a", &a, "main", "auto")["knowledge"]["status"],
        "unavailable"
    );
    let history = status(t.path())["failures"].clone();
    assert_ne!(
        context("test/b", &b, "other-default", "auto")["knowledge"]["status"],
        "unavailable"
    );
    let view = status(t.path());
    assert_eq!(view["failures"], history);
    assert_eq!(view["components"]["knowledge"]["status"], "unconfigured");
    assert!(view["components"]["knowledge"]["target"]["repository"].is_null());
    let persisted: Value =
        serde_json::from_slice(&fs::read(t.path().join(".mimirs/status.json")).unwrap()).unwrap();
    assert_eq!(
        persisted["components"]["knowledge"]["target"]["repository"],
        "test/b"
    );
    fs::write(&journal, &saved).unwrap();
    assert_ne!(
        context("test/a", &a, "main", "auto")["knowledge"]["status"],
        "unavailable"
    );
    assert_eq!(status(t.path())["failures"], history);
    let before: Value =
        serde_json::from_slice(&fs::read(t.path().join(".mimirs/status.json")).unwrap()).unwrap();
    context("test/a", &a, "main", "off");
    let after: Value =
        serde_json::from_slice(&fs::read(t.path().join(".mimirs/status.json")).unwrap()).unwrap();
    assert_eq!(
        before["components"]["knowledge"],
        after["components"]["knowledge"]
    );
    let view = status(t.path());
    assert_eq!(view["components"]["knowledge"]["status"], "unconfigured");
    assert_eq!(view["failures"], history);
    assert_eq!(fs::read(journal).unwrap(), saved);
}

#[test]
fn setup_assessment_and_consumption_have_separate_status_states() {
    let t = project();
    let run = |args: &[&str]| {
        let out = Command::new(env!("CARGO_BIN_EXE_mimirs"))
            .current_dir(t.path())
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        out
    };
    assert_eq!(
        status(t.path())["components"]["relationships"]["status"],
        "absent"
    );
    run(&["knowledge", "setup"]);
    assert_eq!(
        status(t.path())["components"]["knowledge"]["status"],
        "not_yet_assessed"
    );
    run(&["context", "--output", "json", "reader"]);
    assert_eq!(
        status(t.path())["components"]["knowledge"]["status"],
        "configured_empty"
    );
    fs::write(
        t.path().join(".mimirs/config.toml"),
        "[context]\nknowledge='off'\n",
    )
    .unwrap();
    run(&["context", "--output", "json", "reader"]);
    let view = status(t.path());
    assert_eq!(
        view["components"]["knowledge"]["status"],
        "configured_empty"
    );
    assert_eq!(view["components"]["knowledge"]["consumption"], "off");
    // Cheap status does not parse a graph merely because a file exists.
    fs::create_dir_all(t.path().join(".mimirs/watch")).unwrap();
    fs::write(
        t.path().join(".mimirs/watch/relationships.json"),
        "not JSON",
    )
    .unwrap();
    assert_eq!(
        status(t.path())["components"]["relationships"]["status"],
        "unvalidated"
    );
}
