use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
};
struct Fixture {
    temp: tempfile::TempDir,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let a = temp.path().join("a");
        fs::create_dir(&a).unwrap();
        git(&a, &["init", "-b", "trunk"]);
        fs::write(a.join("reader.rs"), "fn reader() { preserve(); }\n").unwrap();
        commit(&a);
        git(
            temp.path(),
            &[
                "clone",
                a.to_str().unwrap(),
                temp.path().join("b").to_str().unwrap(),
            ],
        );
        Self { temp }
    }
    fn root(&self, name: &str) -> PathBuf {
        self.temp.path().join(name)
    }
    fn output(&self, name: &str, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_mimirs"))
            .current_dir(self.root(name))
            .args(args)
            .output()
            .unwrap()
    }
    fn run(&self, name: &str, args: &[&str]) -> Value {
        let r = self.output(name, args);
        assert!(r.status.success(), "{}", String::from_utf8_lossy(&r.stderr));
        serde_json::from_slice(&r.stdout).unwrap()
    }
    fn setup(&self, name: &str) {
        self.run(
            name,
            &[
                "knowledge",
                "setup",
                "--repository",
                "test/shared",
                "--default-branch",
                "trunk",
                "--registry",
                "../registry",
            ],
        );
    }
}
fn git(root: &Path, args: &[&str]) {
    let r = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .unwrap();
    assert!(r.status.success(), "{}", String::from_utf8_lossy(&r.stderr));
}
fn commit(root: &Path) {
    git(root, &["add", "."]);
    git(
        root,
        &[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "-m",
            "fixture",
        ],
    );
}
fn learn(f: &Fixture, name: &str) -> String {
    f.run(
        name,
        &[
            "knowledge",
            "learn",
            "Reader preserves bytes",
            "--evidence",
            "reader.rs",
            "--actor",
            "reviewer",
        ],
    )["knowledge_id"]
        .as_str()
        .unwrap()
        .into()
}

#[test]
fn configured_two_checkout_exchange_review_dedup_and_override_isolation() {
    let f = Fixture::new();
    f.setup("a");
    f.setup("b");
    let id = learn(&f, "a");
    assert_eq!(
        f.run("a", &["knowledge", "exchange-status"])["pending_publish"],
        3
    );
    assert!(!f.root("a").join(".mimirs/index.db").exists());
    assert_eq!(
        f.run("a", &["knowledge", "orient"])["items"][0]["status"],
        "Verified"
    );
    assert_eq!(f.run("a", &["knowledge", "publish"])["published_events"], 3);
    assert_eq!(
        f.run("b", &["knowledge", "exchange-status"])["pending_pull"],
        3
    );
    assert_eq!(f.run("b", &["knowledge", "pull"])["received_events"], 3);
    assert_eq!(f.run("b", &["knowledge", "pull"])["received_events"], 0);
    assert_eq!(
        f.run(
            "b",
            &["knowledge", "--repository", "other/identity", "pull"]
        )["received_events"],
        0
    );
    assert_eq!(
        f.run(
            "b",
            &["knowledge", "--repository", "other/identity", "replay"]
        )["materialized_claims"],
        0
    );
    fs::write(
        f.root("b").join("reader.rs"),
        "// unrelated edit\nfn reader() { preserve(); }\n",
    )
    .unwrap();
    commit(&f.root("b"));
    let tracked = Command::new("git")
        .arg("-C")
        .arg(f.root("b"))
        .args(["ls-files", "--", ".mimirs/knowledge"])
        .output()
        .unwrap();
    assert!(tracked.status.success());
    assert!(tracked.stdout.is_empty());
    let context = f.run("b", &["context", "--output", "json", "reader bytes"]);
    assert_eq!(context["source"]["retrieval"], "failed");
    assert_eq!(
        context["knowledge"]["items"][0]["status"],
        "NeedsRevalidation"
    );
    let selected = f.run("b", &["knowledge", "maintenance", &id]);
    let path = f.temp.path().join("assessment.json");
    fs::write(&path, serde_json::to_vec(&selected).unwrap()).unwrap();
    let denied = f.output(
        "b",
        &[
            "knowledge",
            "--default-branch",
            "main",
            "review",
            "--assessment",
            path.to_str().unwrap(),
            "--actor",
            "reviewer",
            "--reviewed",
        ],
    );
    assert!(!denied.status.success());
    f.run(
        "b",
        &[
            "knowledge",
            "review",
            "--assessment",
            path.to_str().unwrap(),
            "--actor",
            "reviewer",
            "--reviewed",
        ],
    );
    assert_eq!(f.run("b", &["knowledge", "publish"])["published_events"], 1);
    git(
        &f.root("a"),
        &["fetch", f.root("b").to_str().unwrap(), "trunk"],
    );
    git(&f.root("a"), &["merge", "--ff-only", "FETCH_HEAD"]);
    assert_eq!(f.run("a", &["knowledge", "pull"])["received_events"], 1);
    assert_eq!(f.run("a", &["knowledge", "pull"])["received_events"], 0);
    assert_eq!(
        f.run("a", &["knowledge", "replay"])["materialized_claims"],
        1
    );
    assert_eq!(
        f.run("a", &["context", "--output", "json", "reader bytes"])["knowledge"]["items"][0]["status"],
        "Verified"
    );
    let override_dir = f.root("alternate-registry");
    assert_eq!(
        f.run(
            "a",
            &[
                "knowledge",
                "publish",
                "--registry",
                override_dir.to_str().unwrap()
            ]
        )["published_events"],
        4
    );
}

#[test]
fn settings_preserve_source_config_unknown_content_and_idempotent_bytes() {
    let f = Fixture::new();
    f.setup("a");
    let root = f.root("a");
    let path = root.join(".mimirs/knowledge/settings.toml");
    let original = fs::read_to_string(&path).unwrap();
    let ignore = root.join(".mimirs/knowledge/.gitignore");
    let custom_ignore = "# retained local policy\n*\n";
    fs::write(&ignore, custom_ignore).unwrap();
    let custom =
        format!("# keep this comment\n{original}\n[custom]\ncolor = 'blue' # keep formatting\n");
    fs::write(&path, &custom).unwrap();
    let source_config = "include = ['**/*.rs'] # custom\n[extension]\nvalue = 7\n";
    fs::write(root.join(".mimirs/config.toml"), source_config).unwrap();
    assert_eq!(f.run("a", &["knowledge", "setup"])["changed"], false);
    assert_eq!(fs::read_to_string(&path).unwrap(), custom);
    assert_eq!(fs::read_to_string(&ignore).unwrap(), custom_ignore);
    f.run(
        "a",
        &[
            "knowledge",
            "setup",
            "--repository",
            "renamed/logical",
            "--default-branch",
            "main",
        ],
    );
    let after = fs::read_to_string(&path).unwrap();
    assert!(after.contains("# keep this comment"));
    assert!(after.ends_with("[custom]\ncolor = 'blue' # keep formatting\n"));
    assert!(after.contains("renamed/logical"));
    assert_eq!(
        fs::read_to_string(root.join(".mimirs/config.toml")).unwrap(),
        source_config
    );
    let override_result = f.run(
        "a",
        &[
            "knowledge",
            "--repository",
            "one/off",
            "--default-branch",
            "trunk",
            "learn",
            "One off knowledge",
            "--actor",
            "tester",
            "--evidence",
            "reader.rs",
        ],
    );
    assert!(override_result["knowledge_id"].is_string());
    assert_eq!(fs::read_to_string(&path).unwrap(), after);
}

#[test]
fn missing_invalid_and_unavailable_settings_fail_actionably_without_overwrite() {
    let f = Fixture::new();
    let missing = f.output("a", &["knowledge", "orient"]);
    assert!(!missing.status.success());
    assert!(String::from_utf8_lossy(&missing.stderr).contains("setup"));
    f.setup("a");
    let path = f.root("a").join(".mimirs/knowledge/settings.toml");
    for text in [
        "not = [",
        "version = 9\nrepository = 'r'\n",
        "version = 1\nrepository = 99\n",
    ] {
        fs::write(&path, text).unwrap();
        let bad = f.output("a", &["knowledge", "setup", "--repository", "repair"]);
        assert!(!bad.status.success());
        assert_eq!(fs::read_to_string(&path).unwrap(), text);
        let context = f.run("a", &["context", "--output", "json", "reader"]);
        assert_eq!(context["knowledge"]["status"], "unavailable");
        assert!(
            context["knowledge"]["error"]
                .as_str()
                .unwrap()
                .contains("settings")
        );
    }
    fs::remove_file(&path).unwrap();
    fs::create_dir(&path).unwrap();
    assert!(!f.output("a", &["knowledge", "orient"]).status.success());
}

#[test]
fn local_setup_is_shared_by_worktrees_but_independent_across_clones() {
    let f = Fixture::new();
    let metadata = f.root("a").join(".git/mimirs-local-identity.json");
    assert!(!metadata.exists());
    let context = f.run("a", &["context", "--output", "json", "reader"]);
    assert_eq!(context["knowledge"]["status"], "not_configured");
    assert!(!metadata.exists());
    assert!(!f.root("a").join(".mimirs/knowledge/repositories").exists());
    let first = f.run("a", &["knowledge", "setup", "--default-branch", "trunk"]);
    assert!(first["repository"].as_str().unwrap().starts_with("local/"));
    let bytes = fs::read(&metadata).unwrap();
    assert_eq!(
        f.run("a", &["knowledge", "setup"])["repository"],
        first["repository"]
    );
    assert_eq!(fs::read(&metadata).unwrap(), bytes);
    assert_ne!(
        f.run("b", &["knowledge", "setup"])["repository"],
        first["repository"]
    );
    git(
        &f.root("a"),
        &[
            "worktree",
            "add",
            "-b",
            "linked",
            f.root("linked").to_str().unwrap(),
        ],
    );
    // Read-only orientation discovers the common identity without saving local defaults.
    let orient = f.output("linked", &["knowledge", "orient"]);
    assert!(!String::from_utf8_lossy(&orient.stderr).contains("supply --repository"));
    assert!(
        !f.root("linked")
            .join(".mimirs/knowledge/settings.toml")
            .exists()
    );
    assert_eq!(
        f.run("linked", &["knowledge", "setup"])["repository"],
        first["repository"]
    );
    assert_eq!(fs::read(metadata).unwrap(), bytes);
}

#[test]
fn concurrent_local_setup_has_one_identity_and_corrupt_metadata_is_actionable() {
    let f = Fixture::new();
    let results = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..4)
            .map(|_| scope.spawn(|| f.run("a", &["knowledge", "setup"])))
            .collect();
        handles
            .into_iter()
            .map(|h| h.join().unwrap()["repository"].clone())
            .collect::<Vec<_>>()
    });
    assert!(results.iter().all(|r| r == &results[0]));
    fs::remove_file(f.root("a").join(".mimirs/knowledge/settings.toml")).unwrap();
    let metadata = f.root("a").join(".git/mimirs-local-identity.json");
    fs::write(&metadata, "corrupt").unwrap();
    let result = f.output("a", &["knowledge", "setup"]);
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("repair"));
    assert_eq!(fs::read(&metadata).unwrap(), b"corrupt");
    // An explicitly chosen identity remains authoritative over the local fallback.
    assert_eq!(
        f.run(
            "a",
            &["knowledge", "setup", "--repository", "explicit/shared"]
        )["repository"],
        "explicit/shared"
    );
}
