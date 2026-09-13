use serde_json::Value;
use std::{
    fs,
    path::Path,
    process::{Command, Output},
};

struct Fixture {
    temp: tempfile::TempDir,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("a");
        fs::create_dir(&root).unwrap();
        git(&root, &["init", "-b", "main"]);
        fs::write(root.join("auth.rs"), "fn rotate() { auth_service(); }\n").unwrap();
        fs::write(root.join("retry.rs"), "const RETRIES: usize = 3;\n").unwrap();
        commit(&root);
        let b = temp.path().join("b");
        git(
            temp.path(),
            &["clone", root.to_str().unwrap(), b.to_str().unwrap()],
        );
        Self { temp }
    }
    fn root(&self, instance: &str) -> std::path::PathBuf {
        self.temp.path().join(instance)
    }
    fn output(&self, instance: &str, args: &[&str]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_mimirs"))
            .args(["knowledge", "--repository", "test/identity", "--root"])
            .arg(self.root(instance))
            .arg("--state")
            .arg(self.temp.path().join(format!("state-{instance}")))
            .args(args)
            .output()
            .unwrap()
    }
    fn run(&self, instance: &str, args: &[&str]) -> Value {
        let output = self.output(instance, args);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&output.stdout).unwrap()
    }
    fn learn(&self, instance: &str, statement: &str, path: &str) -> String {
        self.run(
            instance,
            &[
                "learn",
                statement,
                "--evidence",
                path,
                "--actor",
                "agent-a",
                "--harness",
                "test",
                "--session",
                "one",
            ],
        )["knowledge_id"]
            .as_str()
            .unwrap()
            .to_owned()
    }
    fn sync(&self) {
        let registry = self.temp.path().join("registry");
        let registry = registry.to_str().unwrap();
        self.run("a", &["publish", "--registry", registry]);
        self.run("b", &["pull", "--registry", registry]);
    }
}
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
fn item<'a>(value: &'a Value, id: &str) -> &'a Value {
    value["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|k| k["knowledge"]["claim"]["id"] == id)
        .unwrap()
}

#[test]
fn two_instances_exchange_events_then_reuse_only_unchanged_support() {
    let fixture = Fixture::new();
    let k1 = fixture.learn("a", "AuthService owns rotation", "auth.rs");
    let k2 = fixture.learn("a", "Retries are bounded at three", "retry.rs");
    fixture.sync();
    let before = fixture.run("b", &["orient"]);
    assert_eq!(item(&before, &k1)["status"], "Verified");
    assert_eq!(item(&before, &k2)["status"], "Verified");
    fs::write(
        fixture.root("b").join("retry.rs"),
        "const RETRIES: usize = 5;\n",
    )
    .unwrap();
    commit(&fixture.root("b"));
    let after = fixture.run("b", &["reconcile"]);
    assert_eq!(item(&after, &k1)["status"], "Verified");
    assert_eq!(item(&after, &k2)["status"], "NeedsRevalidation");
    assert_eq!(item(&after, &k2)["evidence"][0]["comparison"], "Modified");
    assert_eq!(
        fixture.run("b", &["show", &k2])["item"]["evidence"][0]["current_text"],
        "const RETRIES: usize = 5;\n"
    );
    assert_ne!(before["revision"], after["revision"]);
    assert_eq!(after["files_read"], 2);
    fixture.sync();
    assert_eq!(fixture.run("b", &["replay"])["materialized_claims"], 2);
    assert_eq!(fixture.run("b", &["orient"]), after);
    assert!(!fixture.root("b").join(".mimirs/index.db").exists());
}

#[test]
fn dirty_working_tree_and_deletions_override_prior_verification() {
    let fixture = Fixture::new();
    let id = fixture.learn("a", "Auth owns rotation", "auth.rs");
    let before = fixture.run("a", &["orient"]);
    fs::write(
        fixture.root("a").join("auth.rs"),
        "fn rotate() { token_manager(); }\n",
    )
    .unwrap();
    let dirty = fixture.run("a", &["orient"]);
    assert_eq!(before["revision"], dirty["revision"]);
    assert_eq!(item(&dirty, &id)["status"], "NeedsRevalidation");
    let provisional = fixture.learn("a", "TokenManager owns rotation", "auth.rs");
    assert_eq!(
        item(&fixture.run("a", &["orient"]), &provisional)["status"],
        "Provisional"
    );
    fs::remove_file(fixture.root("a").join("auth.rs")).unwrap();
    let missing = fixture.run("a", &["orient"]);
    assert_eq!(item(&missing, &id)["evidence"][0]["comparison"], "Missing");
    assert!(item(&missing, &id)["evidence"][0]["current_text"].is_null());
}

#[test]
fn branch_knowledge_never_becomes_verified_on_main_by_hash_alone() {
    let fixture = Fixture::new();
    git(&fixture.root("a"), &["checkout", "-b", "feature"]);
    let id = fixture.learn("a", "branch conclusion", "auth.rs");
    fixture.sync();
    assert_eq!(
        item(&fixture.run("b", &["orient"]), &id)["status"],
        "Provisional"
    );
    // A main claim from a newer commit is not applicable to the old checkout,
    // even if its particular evidence file was unchanged.
    git(&fixture.root("a"), &["checkout", "main"]);
    fs::write(fixture.root("a").join("new.rs"), "new state").unwrap();
    commit(&fixture.root("a"));
    let future = fixture.learn("a", "new main conclusion", "auth.rs");
    fixture.sync();
    assert_eq!(
        item(&fixture.run("b", &["orient"]), &future)["status"],
        "NeedsRevalidation"
    );
}

#[test]
fn supersession_preserves_history_and_conflicts_require_review() {
    let fixture = Fixture::new();
    let a = fixture.learn("a", "old explanation", "auth.rs");
    let b = fixture.learn("a", "replacement explanation", "auth.rs");
    fixture.run(
        "a",
        &[
            "supersede",
            &a,
            &b,
            "--actor",
            "reviewer",
            "--actor-kind",
            "human",
        ],
    );
    fixture.sync();
    let view = fixture.run("b", &["orient", "--max-bytes", "32000"]);
    assert_eq!(item(&view, &a)["status"], "Superseded");
    assert_eq!(item(&view, &b)["status"], "Verified");
    assert_eq!(
        item(&view, &a)["knowledge"]["claim"]["statement"],
        "old explanation"
    );
    let c = fixture.learn("a", "another replacement", "auth.rs");
    fixture.run("a", &["supersede", &a, &c, "--actor", "other-reviewer"]);
    let conflict = fixture.run("a", &["orient", "--max-bytes", "32000"]);
    assert_eq!(item(&conflict, &a)["status"], "NeedsRevalidation");
    assert_eq!(item(&conflict, &a)["relationship_conflict"], true);
    fixture.run("a", &["supersede", &b, &a, "--actor", "reviewer"]);
    let cycle = fixture.run("a", &["orient", "--max-bytes", "32000"]);
    assert_eq!(item(&cycle, &b)["relationship_conflict"], true);
}

#[test]
fn context_obeys_wire_budget_and_reports_omissions() {
    let fixture = Fixture::new();
    fixture.learn("a", &"claim ".repeat(1000), "auth.rs");
    let output = fixture.output("a", &["orient", "--max-bytes", "1024"]);
    assert!(output.status.success());
    assert!(output.stdout.len() <= 1024);
    let json: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(json["omitted"], 0);
    assert_eq!(json["items"].as_array().unwrap().len(), 1);
    assert_eq!(json["items"][0]["summary_omitted"], true);
    assert!(json["items"][0]["knowledge"]["claim"]["statement"].is_null());
}

#[cfg(unix)]
#[test]
fn evidence_cannot_read_outside_repository_through_symlinks() {
    let fixture = Fixture::new();
    fs::write(fixture.temp.path().join("secret"), "outside").unwrap();
    std::os::unix::fs::symlink(
        fixture.temp.path().join("secret"),
        fixture.root("a").join("link.rs"),
    )
    .unwrap();
    let output = fixture.output(
        "a",
        &["learn", "bad", "--evidence", "link.rs", "--actor", "test"],
    );
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("escapes repository"));
    assert_eq!(fixture.run("a", &["replay"])["materialized_claims"], 0);
}

#[test]
fn ignored_uncommitted_support_is_provisional_even_when_git_status_is_clean() {
    let fixture = Fixture::new();
    fs::write(fixture.root("a").join(".gitignore"), "ignored.rs\n").unwrap();
    commit(&fixture.root("a"));
    fs::write(fixture.root("a").join("ignored.rs"), "local only").unwrap();
    let id = fixture.learn("a", "local observation", "ignored.rs");
    let view = fixture.run("a", &["orient"]);
    assert_eq!(item(&view, &id)["status"], "Provisional");
    assert_eq!(item(&view, &id)["knowledge"]["claim"]["dirty"], true);
}

#[test]
fn default_state_does_not_make_an_otherwise_clean_repository_provisional() {
    let fixture = Fixture::new();
    let run = |args: &[&str]| {
        let output = Command::new(env!("CARGO_BIN_EXE_mimirs"))
            .args(["knowledge", "--repository", "test/identity", "--root"])
            .arg(fixture.root("a"))
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice::<Value>(&output.stdout).unwrap()
    };
    let learned = run(&[
        "learn",
        "clean observation",
        "--evidence",
        "auth.rs",
        "--actor",
        "test",
    ]);
    assert_eq!(
        item(&run(&["orient"]), learned["knowledge_id"].as_str().unwrap())["status"],
        "Verified"
    );
}

#[test]
fn supersession_on_a_future_revision_does_not_hide_current_main_knowledge() {
    let fixture = Fixture::new();
    let old = fixture.learn("a", "old explanation", "auth.rs");
    fs::write(fixture.root("a").join("new.rs"), "new subsystem").unwrap();
    commit(&fixture.root("a"));
    let new = fixture.learn("a", "new explanation", "auth.rs");
    fixture.run("a", &["supersede", &old, &new, "--actor", "test"]);
    fixture.sync();
    let view = fixture.run("b", &["orient"]);
    assert_eq!(item(&view, &old)["status"], "Verified");
    assert_eq!(item(&view, &new)["status"], "NeedsRevalidation");
}

fn heads(view: &Value, id: &str) -> Vec<String> {
    item(view, id)["review_heads"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_owned())
        .collect()
}
fn review_assessment(
    fixture: &Fixture,
    instance: &str,
    id: &str,
    paths: &[&str],
    parents: &[String],
) -> std::path::PathBuf {
    let mut args = vec!["maintenance", id];
    for path in paths {
        args.extend(["--evidence", path]);
    }
    let mut value = fixture.run(instance, &args);
    // Tests can supply stale or partial heads to verify rejection at the boundary.
    value["assessment"]["review_heads"] = serde_json::json!(parents);
    let path = fixture
        .temp
        .path()
        .join(format!("review-{}.json", uuid::Uuid::now_v7()));
    fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
    path
}
fn review(
    fixture: &Fixture,
    instance: &str,
    id: &str,
    paths: &[&str],
    parents: &[String],
    promote: bool,
) -> Value {
    let assessment = review_assessment(fixture, instance, id, paths, parents);
    let mut args = vec![
        "review",
        "--assessment",
        assessment.to_str().unwrap(),
        "--reviewed",
        "--actor",
        "reviewing-agent",
        "--harness",
        "generic",
        "--session",
        "review-session",
    ];
    for path in paths {
        args.extend(["--evidence", path]);
    }
    if promote {
        args.push("--promote");
    }
    fixture.run(instance, &args)
}
fn transfer(fixture: &Fixture, from: &str, to: &str) {
    let registry = fixture.temp.path().join("registry");
    fixture.run(from, &["publish", "--registry", registry.to_str().unwrap()]);
    fixture.run(to, &["pull", "--registry", registry.to_str().unwrap()]);
}
fn receive_git(fixture: &Fixture, from: &str, to: &str) {
    git(
        &fixture.root(to),
        &["fetch", fixture.root(from).to_str().unwrap(), "main"],
    );
    git(&fixture.root(to), &["merge", "--ff-only", "FETCH_HEAD"]);
}
fn revision(root: &Path) -> String {
    String::from_utf8(
        Command::new("git")
            .arg("-C")
            .arg(root)
            .args(["rev-parse", "HEAD"])
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap()
    .trim()
    .into()
}

#[test]
fn portable_review_closes_the_loop_without_rewriting_claim_or_history() {
    let fixture = Fixture::new();
    let k1 = fixture.learn("a", "Auth owns rotation", "auth.rs");
    let k2 = fixture.learn("a", "Retries are bounded", "retry.rs");
    fixture.sync();
    let before = fixture.run("b", &["orient"]);
    let original = item(&before, &k2)["knowledge"].clone();
    let base = heads(&before, &k2);
    fs::write(
        fixture.root("b").join("retry.rs"),
        "const RETRIES: usize = 5;\n",
    )
    .unwrap();
    commit(&fixture.root("b"));
    assert_eq!(
        item(&fixture.run("b", &["orient"]), &k2)["status"],
        "NeedsRevalidation"
    );
    let reviewed = review(&fixture, "b", &k2, &["retry.rs"], &base, false);
    let local = fixture.run("b", &["orient"]);
    assert_eq!(item(&local, &k2)["knowledge"], original);
    assert_eq!(item(&local, &k2)["status"], "Verified");
    assert_eq!(
        item(&local, &k2)["assessed_review"],
        reviewed["review_event"]
    );
    assert_eq!(
        item(&local, &k2)["reviews"][0]["actor"]["id"],
        "reviewing-agent"
    );
    assert_eq!(
        item(&local, &k2)["reviews"][0]["revision"],
        local["revision"]
    );
    transfer(&fixture, "b", "a");
    let old_checkout = fixture.run("a", &["orient"]);
    assert_eq!(heads(&old_checkout, &k2), base);
    assert_eq!(item(&old_checkout, &k2)["status"], "Verified");
    receive_git(&fixture, "b", "a");
    let received = fixture.run("a", &["orient"]);
    assert_eq!(item(&received, &k1)["status"], "Verified");
    assert_eq!(item(&received, &k2)["status"], "Verified");
    assert_eq!(
        item(&received, &k2)["assessed_review"],
        reviewed["review_event"]
    );
    assert_eq!(
        fixture.run("a", &["show", &k2])["item"]["evidence"][0]["current_text"],
        "const RETRIES: usize = 5;\n"
    );
    fs::write(
        fixture.root("a").join("retry.rs"),
        "const RETRIES: usize = 3;\n",
    )
    .unwrap();
    assert_eq!(
        item(&fixture.run("a", &["orient"]), &k2)["status"],
        "NeedsRevalidation"
    );
}

#[test]
fn review_replaces_adds_and_removes_whole_file_support_without_requiring_retired_hashes() {
    let fixture = Fixture::new();
    let learned = fixture.run(
        "a",
        &[
            "learn",
            "supported conclusion",
            "--evidence",
            "auth.rs",
            "--evidence",
            "retry.rs",
            "--actor",
            "test",
        ],
    );
    let id = learned["knowledge_id"].as_str().unwrap();
    let old_revision = revision(&fixture.root("a"));
    let before = fixture.run("a", &["orient"]);
    fs::remove_file(fixture.root("a").join("retry.rs")).unwrap();
    fs::write(
        fixture.root("a").join("auth.rs"),
        "fn rotate() { checked_auth_service(); }\n",
    )
    .unwrap();
    fs::write(
        fixture.root("a").join("contract.md"),
        "Rotation belongs to auth.\n",
    )
    .unwrap();
    commit(&fixture.root("a"));
    review(
        &fixture,
        "a",
        id,
        &["auth.rs", "contract.md"],
        &heads(&before, id),
        false,
    );
    let after = fixture.run("a", &["orient"]);
    assert_eq!(item(&after, id)["status"], "Verified");
    assert_eq!(after["files_read"], 2);
    let paths: Vec<_> = item(&after, id)["evidence"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["path"].as_str().unwrap())
        .collect();
    assert_eq!(paths, ["auth.rs", "contract.md"]);
    let new_revision = revision(&fixture.root("a"));
    git(&fixture.root("a"), &["checkout", "--detach", &old_revision]);
    let old = fixture.run("a", &["orient"]);
    assert_eq!(item(&old, id)["status"], "Verified");
    assert_eq!(heads(&old, id), heads(&before, id));
    assert_eq!(item(&old, id)["evidence"][1]["path"], "retry.rs");
    git(&fixture.root("a"), &["checkout", "--detach", &new_revision]);
    fs::write(fixture.root("a").join("contract.md"), "Changed contract\n").unwrap();
    assert_eq!(
        item(&fixture.run("a", &["orient"]), id)["status"],
        "NeedsRevalidation"
    );
}

#[test]
fn merged_branch_requires_explicit_portable_promotion_and_later_reviews_retain_it() {
    let fixture = Fixture::new();
    git(&fixture.root("a"), &["checkout", "-b", "feature"]);
    fs::write(
        fixture.root("a").join("auth.rs"),
        "fn rotate() { branch_auth(); }\n",
    )
    .unwrap();
    commit(&fixture.root("a"));
    let feature_revision = revision(&fixture.root("a"));
    let id = fixture.learn("a", "Auth still owns rotation", "auth.rs");
    let initial = fixture.run("a", &["orient"]);
    git(&fixture.root("a"), &["checkout", "main"]);
    git(
        &fixture.root("a"),
        &[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "merge",
            "--no-ff",
            "feature",
            "-m",
            "merge feature",
        ],
    );
    let merged = fixture.run("a", &["orient"]);
    assert_eq!(item(&merged, &id)["status"], "Provisional");
    assert_eq!(item(&merged, &id)["applicable_explicit_promotion"], false);
    review(
        &fixture,
        "a",
        &id,
        &["auth.rs"],
        &heads(&merged, &id),
        false,
    );
    let reviewed = fixture.run("a", &["orient"]);
    assert_eq!(item(&reviewed, &id)["status"], "Provisional");
    review(
        &fixture,
        "a",
        &id,
        &["auth.rs"],
        &heads(&reviewed, &id),
        true,
    );
    let promoted = fixture.run("a", &["orient"]);
    assert_eq!(item(&promoted, &id)["status"], "Verified");
    assert_eq!(
        item(&promoted, &id)["knowledge"],
        item(&initial, &id)["knowledge"]
    );
    assert_eq!(
        item(&promoted, &id)["knowledge"]["claim"]["provisional"],
        true
    );
    assert_eq!(
        item(&promoted, &id)["knowledge"]["claim"]["branch"],
        "feature"
    );
    assert_eq!(item(&promoted, &id)["applicable_explicit_promotion"], true);
    receive_git(&fixture, "a", "b");
    fixture.sync();
    assert_eq!(
        item(&fixture.run("b", &["orient"]), &id)["status"],
        "Verified"
    );
    git(
        &fixture.root("b"),
        &["checkout", "--detach", &feature_revision],
    );
    let old = fixture.run("b", &["orient"]);
    assert_eq!(item(&old, &id)["status"], "Provisional");
    assert_eq!(item(&old, &id)["applicable_explicit_promotion"], false);
    fs::write(
        fixture.root("a").join("auth.rs"),
        "fn rotate() { improved_auth(); }\n",
    )
    .unwrap();
    commit(&fixture.root("a"));
    review(
        &fixture,
        "a",
        &id,
        &["auth.rs"],
        &heads(&promoted, &id),
        false,
    );
    let updated = fixture.run("a", &["orient"]);
    assert_eq!(item(&updated, &id)["status"], "Verified");
    assert_eq!(item(&updated, &id)["applicable_explicit_promotion"], true);
}

#[test]
fn concurrent_reviews_remain_conflicted_until_explicitly_replaced_together() {
    let fixture = Fixture::new();
    let id = fixture.learn("a", "reviewed conclusion", "auth.rs");
    fixture.sync();
    let base = heads(&fixture.run("a", &["orient"]), &id);
    let a = review(&fixture, "a", &id, &["auth.rs"], &base, false);
    let b = review(&fixture, "b", &id, &["retry.rs"], &base, false);
    // Both reviews are valid offline. Union must not select one by its UUID or clock.
    transfer(&fixture, "a", "b");
    transfer(&fixture, "b", "a");
    let conflict = fixture.run("a", &["orient"]);
    let k = item(&conflict, &id);
    assert_eq!(k["status"], "NeedsRevalidation");
    assert_eq!(k["review_conflict"], true);
    assert!(k["assessed_review"].is_null());
    assert_eq!(k["review_heads"].as_array().unwrap().len(), 2);
    assert!(
        k["review_heads"]
            .as_array()
            .unwrap()
            .contains(&a["review_event"])
    );
    assert!(
        k["review_heads"]
            .as_array()
            .unwrap()
            .contains(&b["review_event"])
    );
    assert_eq!(item(&fixture.run("b", &["orient"]), &id), k);
    let stale_path = review_assessment(&fixture, "a", &id, &["auth.rs"], &base);
    let stale = fixture.output(
        "a",
        &[
            "review",
            "--assessment",
            stale_path.to_str().unwrap(),
            "--reviewed",
            "--actor",
            "test",
        ],
    );
    assert!(!stale.status.success());
    assert!(String::from_utf8_lossy(&stale.stderr).contains("stale assessment"));
    let partial_path = review_assessment(
        &fixture,
        "a",
        &id,
        &["auth.rs"],
        &[a["review_event"].as_str().unwrap().to_owned()],
    );
    let partial = fixture.output(
        "a",
        &[
            "review",
            "--assessment",
            partial_path.to_str().unwrap(),
            "--reviewed",
            "--actor",
            "test",
        ],
    );
    assert!(!partial.status.success());
    assert!(String::from_utf8_lossy(&partial.stderr).contains("stale assessment"));
    let resolved = review(
        &fixture,
        "a",
        &id,
        &["auth.rs", "retry.rs"],
        &heads(&conflict, &id),
        false,
    );
    transfer(&fixture, "a", "b");
    let final_view = fixture.run("b", &["orient"]);
    assert_eq!(item(&final_view, &id)["status"], "Verified");
    assert_eq!(item(&final_view, &id)["review_conflict"], false);
    assert_eq!(
        item(&final_view, &id)["assessed_review"],
        resolved["review_event"]
    );
    assert_eq!(
        fixture.run("b", &["show", &id])["item"]["reviews"][0]["replaces"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn review_requires_explicit_assertion_clean_default_branch_and_committed_support() {
    let fixture = Fixture::new();
    let id = fixture.learn("a", "reviewed conclusion", "auth.rs");
    let parent = heads(&fixture.run("a", &["orient"]), &id).remove(0);
    let assessment = review_assessment(
        &fixture,
        "a",
        &id,
        &["auth.rs"],
        std::slice::from_ref(&parent),
    );
    let args = [
        "review",
        "--assessment",
        assessment.to_str().unwrap(),
        "--actor",
        "test",
    ];
    assert!(!fixture.output("a", &args).status.success());
    let mut args = args.to_vec();
    args.push("--reviewed");
    fs::write(fixture.root("a").join("auth.rs"), "dirty").unwrap();
    let refreshed = review_assessment(
        &fixture,
        "a",
        &id,
        &["auth.rs"],
        std::slice::from_ref(&parent),
    );
    fs::copy(refreshed, &assessment).unwrap();
    let dirty = fixture.output("a", &args);
    assert!(!dirty.status.success());
    assert!(String::from_utf8_lossy(&dirty.stderr).contains("clean checkout"));
    git(&fixture.root("a"), &["restore", "auth.rs"]);
    git(&fixture.root("a"), &["checkout", "-b", "feature"]);
    let refreshed = review_assessment(
        &fixture,
        "a",
        &id,
        &["auth.rs"],
        std::slice::from_ref(&parent),
    );
    fs::copy(refreshed, &assessment).unwrap();
    let feature = fixture.output("a", &args);
    assert!(!feature.status.success());
    assert!(String::from_utf8_lossy(&feature.stderr).contains("configured default branch"));
    git(&fixture.root("a"), &["checkout", "main"]);
    fs::write(fixture.root("a").join(".gitignore"), "ignored.rs\n").unwrap();
    commit(&fixture.root("a"));
    fs::write(fixture.root("a").join("ignored.rs"), "uncommitted support").unwrap();
    let ignored_assessment = review_assessment(
        &fixture,
        "a",
        &id,
        &["ignored.rs"],
        std::slice::from_ref(&parent),
    );
    let ignored = fixture.output(
        "a",
        &[
            "review",
            "--assessment",
            ignored_assessment.to_str().unwrap(),
            "--evidence",
            "ignored.rs",
            "--reviewed",
            "--actor",
            "test",
        ],
    );
    assert!(!ignored.status.success());
    assert!(String::from_utf8_lossy(&ignored.stderr).contains("uncommitted"));
    assert_eq!(heads(&fixture.run("a", &["orient"]), &id), [parent]);
}

#[test]
fn default_branch_policy_is_local_and_does_not_reinterpret_received_history() {
    let fixture = Fixture::new();
    git(&fixture.root("a"), &["branch", "-m", "trunk"]);
    let learned = fixture.run(
        "a",
        &[
            "--default-branch",
            "trunk",
            "learn",
            "trunk conclusion",
            "--evidence",
            "auth.rs",
            "--actor",
            "trunk-agent",
        ],
    );
    let id = learned["knowledge_id"].as_str().unwrap();
    let view = fixture.run("a", &["orient"]);
    assert_eq!(item(&view, id)["status"], "Verified");
    assert_eq!(
        item(&view, id)["knowledge"]["claim"]["default_branch"],
        "trunk"
    );
    let parent = heads(&view, id).remove(0);
    let inspection = fixture.run(
        "a",
        &[
            "--default-branch",
            "trunk",
            "maintenance",
            id,
            "--evidence",
            "auth.rs",
        ],
    );
    assert_eq!(
        inspection["assessment"]["review_heads"],
        serde_json::json!([parent])
    );
    let assessment = fixture.temp.path().join("trunk-assessment.json");
    fs::write(&assessment, serde_json::to_vec(&inspection).unwrap()).unwrap();
    let reviewed = fixture.run(
        "a",
        &[
            "--default-branch",
            "trunk",
            "review",
            "--assessment",
            assessment.to_str().unwrap(),
            "--reviewed",
            "--actor",
            "trunk-reviewer",
        ],
    );
    fixture.sync();
    let received = fixture.run("b", &["orient"]);
    assert_eq!(item(&received, id)["status"], "Verified");
    assert_eq!(
        item(&received, id)["assessed_review"],
        reviewed["review_event"]
    );
    assert_eq!(
        item(&received, id)["reviews"][0]["actor"]["id"],
        "trunk-reviewer"
    );
}

#[test]
fn an_applicable_review_with_a_parent_from_its_future_cannot_hide_behind_old_verification() {
    let fixture = Fixture::new();
    let id = fixture.learn("a", "conclusion", "auth.rs");
    let old_revision = revision(&fixture.root("a"));
    let prior = heads(&fixture.run("a", &["orient"]), &id);
    fs::write(fixture.root("a").join("new.rs"), "new revision").unwrap();
    commit(&fixture.root("a"));
    let valid = review(&fixture, "a", &id, &["auth.rs"], &prior, false);
    let state = fixture.temp.path().join("state-a/repositories");
    let directory = fs::read_dir(state)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path()
        .join("events");
    let mut event = fs::read_dir(&directory)
        .unwrap()
        .flat_map(|entry| {
            let segment: Value =
                serde_json::from_slice(&fs::read(entry.unwrap().path()).unwrap()).unwrap();
            segment["events"].as_array().unwrap().clone()
        })
        .find(|event| event["id"] == valid["review_event"])
        .unwrap();
    // An imported client may claim a review at a revision preceding its parent.
    // Add a synthetic event without changing any existing event file.
    event["id"] = serde_json::json!(uuid::Uuid::now_v7());
    event["payload"]["review"]["replaces"] = serde_json::json!([valid["review_event"]]);
    event["payload"]["review"]["revision"]["commit"] = serde_json::json!(old_revision);
    fs::write(
        directory.join("invalid-ancestry.json"),
        serde_json::to_vec(&serde_json::json!({ "version": 2, "events": [event] })).unwrap(),
    )
    .unwrap();
    let view = fixture.run("a", &["orient"]);
    assert_eq!(item(&view, &id)["status"], "NeedsRevalidation");
    assert_eq!(
        item(&view, &id)["invalid_reviews"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(item(&view, &id)["assessed_review"].is_null());
}

#[test]
fn compatibility_claims_fit_compact_default_without_rewriting_events() {
    let claims: Value =
        serde_json::from_str(include_str!("fixtures/knowledge/compact-claims.json")).unwrap();
    for family in ["a", "b"] {
        let fixture = Fixture::new();
        let selected: Vec<_> = claims
            .as_array()
            .unwrap()
            .iter()
            .filter(|c| c["family"] == family)
            .collect();
        for claim in &selected {
            for path in claim["evidence"].as_array().unwrap() {
                let path = path.as_str().unwrap();
                let target = fixture.root("a").join(path);
                fs::create_dir_all(target.parent().unwrap()).unwrap();
                // Preserve the historical claim paths while reading their moved implementation.
                let current = match path {
                    "src/retrieval/normalized.rs" => "src/source/normalized.rs",
                    "src/commands/index/parallel.rs" => "src/index/parallel.rs",
                    "src/commands/index.rs" => "src/index.rs",
                    path => path,
                };
                fs::copy(Path::new(env!("CARGO_MANIFEST_DIR")).join(current), target).unwrap();
            }
        }
        commit(&fixture.root("a"));
        for claim in selected {
            let mut args = vec![
                "learn",
                claim["statement"].as_str().unwrap(),
                "--rationale",
                claim["rationale"].as_str().unwrap(),
                "--actor",
                "compatibility-fixture",
            ];
            for path in claim["evidence"].as_array().unwrap() {
                args.extend(["--evidence", path.as_str().unwrap()]);
            }
            fixture.run("a", &args);
        }
        let events = journal_bytes(&fixture, "a");
        let output = fixture.output("a", &["orient"]);
        assert!(output.status.success());
        assert!(output.stdout.len() <= 16000);
        let view: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(view["items"].as_array().unwrap().len(), 3);
        assert_eq!(view["omitted"], 0);
        assert!(view["next_after"].is_null());
        for summary in view["items"].as_array().unwrap() {
            assert_eq!(summary["status"], "Verified");
            assert!(summary["evidence"][0].get("current_text").is_none());
            assert!(summary["reviews"][0].get("evidence").is_none());
            let id = summary["knowledge"]["claim"]["id"].as_str().unwrap();
            let detail = fixture.run("a", &["show", id, "--history", "--max-bytes", "100000"]);
            assert_eq!(detail["item"]["review_heads"], summary["review_heads"]);
            assert_eq!(
                detail["item"]["knowledge"]["claim"]["statement"],
                summary["knowledge"]["claim"]["statement"]
            );
            assert!(detail["history"]["claim"].is_object());
        }
        assert_eq!(events, journal_bytes(&fixture, "a"));
    }
}

fn journal_bytes(fixture: &Fixture, instance: &str) -> Vec<Vec<u8>> {
    let repository = fs::read_dir(
        fixture
            .temp
            .path()
            .join(format!("state-{instance}/repositories")),
    )
    .unwrap()
    .next()
    .unwrap()
    .unwrap()
    .path();
    let mut bytes: Vec<_> = fs::read_dir(repository.join("events"))
        .unwrap()
        .map(|e| fs::read(e.unwrap().path()).unwrap())
        .collect();
    bytes.sort();
    bytes
}

#[test]
fn bounded_pages_discover_every_claim_once_including_oversized_statements() {
    let fixture = Fixture::new();
    let mut ids = vec![fixture.learn("a", &"巨大 assertion ".repeat(1000), "auth.rs")];
    for n in 0..6 {
        ids.push(fixture.learn(
            "a",
            &format!("claim {n}: {}", "detail ".repeat(70)),
            "auth.rs",
        ));
    }
    let mut found = vec![];
    let mut cursor: Option<String> = None;
    for _ in 0..10 {
        let mut args = vec!["orient", "--max-bytes", "2500"];
        if let Some(ref after) = cursor {
            args.extend(["--after", after]);
        }
        let output = fixture.output("a", &args);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(output.stdout.len() <= 2500);
        let page: Value = serde_json::from_slice(&output.stdout).unwrap();
        let items = page["items"].as_array().unwrap();
        assert!(!items.is_empty());
        assert_eq!(
            page["omitted"].as_u64().unwrap() as usize,
            ids.len() - items.len()
        );
        for item in items {
            let id = item["knowledge"]["claim"]["id"]
                .as_str()
                .unwrap()
                .to_owned();
            if id == ids[0] {
                assert_eq!(item["summary_omitted"], true);
                assert!(item["knowledge"]["claim"]["statement"].is_null());
            }
            assert!(!found.contains(&id));
            found.push(id);
        }
        if page["next_after"].is_null() {
            assert_eq!(page["remaining"], 0);
            break;
        }
        cursor = Some(page["next_after"].as_str().unwrap().to_owned());
        assert_eq!(cursor.as_ref(), found.last());
    }
    assert_eq!(found, ids);
    let unknown = uuid::Uuid::nil().to_string();
    for args in [vec!["show", &unknown], vec!["orient", "--after", &unknown]] {
        let output = fixture.output("a", &args);
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains("unknown"));
    }
}

#[test]
fn lookup_is_live_bounded_and_retains_essential_assertion_ahead_of_history() {
    let fixture = Fixture::new();
    let source = "🧭é\"\\\n".repeat(800);
    fs::write(fixture.root("a").join("auth.rs"), &source).unwrap();
    commit(&fixture.root("a"));
    let id = fixture.learn("a", "Exact snapshot support", "auth.rs");
    let events = journal_bytes(&fixture, "a");
    let full = fixture.output("a", &["show", &id]);
    assert!(full.status.success());
    let detail: Value = serde_json::from_slice(&full.stdout).unwrap();
    let preview = detail["item"]["evidence"][0]["current_text"]
        .as_str()
        .unwrap();
    assert!(source.starts_with(preview));
    assert!(preview.len() <= 2048);
    assert_eq!(detail["item"]["evidence"][0]["text_truncated"], true);
    let exact = full.stdout.len().to_string();
    assert_eq!(
        fixture
            .output("a", &["show", &id, "--max-bytes", &exact])
            .stdout,
        full.stdout
    );
    let small = fixture.output("a", &["show", &id, "--history", "--max-bytes", "2500"]);
    assert!(small.status.success());
    assert!(small.stdout.len() <= 2500);
    let small: Value = serde_json::from_slice(&small.stdout).unwrap();
    assert_eq!(
        small["item"]["knowledge"]["claim"]["statement"],
        "Exact snapshot support"
    );
    assert_eq!(
        small["item"]["review_heads"],
        detail["item"]["review_heads"]
    );
    assert!(!small["omitted_fields"].as_array().unwrap().is_empty());
    fs::write(fixture.root("a").join("auth.rs"), "modified").unwrap();
    let changed = fixture.run("a", &["show", &id]);
    assert_eq!(changed["item"]["status"], "NeedsRevalidation");
    assert_eq!(changed["item"]["evidence"][0]["comparison"], "Modified");
    assert_ne!(
        changed["item"]["evidence"][0]["expected_sha256"],
        changed["item"]["evidence"][0]["current_sha256"]
    );
    fs::remove_file(fixture.root("a").join("auth.rs")).unwrap();
    let missing = fixture.run("a", &["show", &id]);
    assert_eq!(missing["item"]["status"], "NeedsRevalidation");
    assert_eq!(missing["item"]["evidence"][0]["comparison"], "Missing");
    assert!(missing["item"]["evidence"][0]["current_text"].is_null());
    assert_eq!(events, journal_bytes(&fixture, "a"));
}

#[test]
fn oversized_lookup_never_presents_a_partial_assertion_and_help_explains_read_operations() {
    let fixture = Fixture::new();
    let text = "长い statement ".repeat(2000);
    let id = fixture.learn("a", &text, "auth.rs");
    let limited = fixture.run("a", &["show", &id, "--max-bytes", "2000"]);
    assert_eq!(limited["item"]["summary_omitted"], true);
    assert!(limited["item"]["knowledge"]["claim"]["statement"].is_null());
    assert!(!limited["omitted_fields"].as_array().unwrap().is_empty());
    let full = fixture.run("a", &["show", &id, "--max-bytes", "100000"]);
    assert_eq!(full["item"]["knowledge"]["claim"]["statement"], text);
    for args in [
        vec!["--help"],
        vec!["show", "--help"],
        vec!["orient", "--help"],
    ] {
        let output = fixture.output("a", &args);
        assert!(output.status.success());
        let help = String::from_utf8(output.stdout).unwrap();
        assert!(help.contains("show") || help.contains("--after"));
    }
}

#[test]
fn overview_does_not_grow_with_historical_promotions_and_lookup_keeps_conflicts() {
    let fixture = Fixture::new();
    git(&fixture.root("a"), &["checkout", "-b", "feature"]);
    let id = fixture.learn("a", "Feature ownership", "auth.rs");
    assert_eq!(
        fixture.run("a", &["show", &id])["item"]["status"],
        "Provisional"
    );
    git(&fixture.root("a"), &["checkout", "main"]);
    let mut view = fixture.run("a", &["orient"]);
    for _ in 0..8 {
        review(&fixture, "a", &id, &["auth.rs"], &heads(&view, &id), true);
        view = fixture.run("a", &["orient"]);
    }
    let summary = item(&view, &id);
    assert_eq!(summary["status"], "Verified");
    assert_eq!(summary["applicable_explicit_promotion"], true);
    assert!(summary.get("promotions").is_none());
    assert_eq!(summary["reviews"].as_array().unwrap().len(), 1);
    assert!(serde_json::to_vec(&view).unwrap().len() < 3000);
    let detail = fixture.run("a", &["show", &id, "--history", "--max-bytes", "100000"]);
    assert_eq!(detail["history"]["reviews"].as_array().unwrap().len(), 8);
    assert_eq!(detail["item"]["promotions"].as_array().unwrap().len(), 8);
    fixture.sync();
    let parent = heads(&view, &id);
    review(&fixture, "a", &id, &["auth.rs"], &parent, false);
    review(&fixture, "b", &id, &["auth.rs"], &parent, false);
    transfer(&fixture, "b", "a");
    let conflict = fixture.run("a", &["show", &id]);
    assert_eq!(conflict["item"]["review_conflict"], true);
    assert_eq!(conflict["item"]["status"], "NeedsRevalidation");
    assert_eq!(
        conflict["item"]["review_heads"].as_array().unwrap().len(),
        2
    );
    let overview = fixture.run("a", &["orient"]);
    assert_eq!(
        item(&overview, &id)["review_heads"],
        conflict["item"]["review_heads"]
    );
}

#[path = "support/maintenance_cli.rs"]
mod maintenance;

#[path = "support/release_repairs.rs"]
mod release_repairs;

#[path = "support/hardening.rs"]
mod hardening;

#[test]
fn review_exposes_only_the_assessment_workflow() {
    let cli = env!("CARGO_BIN_EXE_mimirs");
    let help = Command::new(cli)
        .args(["knowledge", "review", "--help"])
        .output()
        .unwrap();
    assert!(help.status.success());
    let help = String::from_utf8(help.stdout).unwrap();
    assert!(help.contains("--assessment"));
    assert!(!help.contains("--replaces"));
    let removed = Command::new(cli)
        .args(["knowledge", "review-assessed", "--help"])
        .output()
        .unwrap();
    assert_eq!(removed.status.code(), Some(2));
}
