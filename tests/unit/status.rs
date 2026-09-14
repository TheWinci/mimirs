use super::*;
use serde_json::json;

#[test]
fn real_index_success_failure_and_retry_record_only_published_work() {
    use crate::context::test_support::{Fixture, fixed};
    let f = Fixture::new();
    f.index(&[("reader.rs", "fn read_bytes() {}\n")]);
    let run = |make| {
        crate::index::run_at(
            &f.root,
            make,
            &mut Vec::new(),
            &mut Vec::new(),
            false,
            &|| Duration::ZERO,
        )
    };
    run(fixed as fn() -> Result<crate::embedding::Embedder>).unwrap();
    let snapshot = load(&f.root).unwrap().unwrap();
    assert_eq!(snapshot.last_success.unwrap().operation, "index");
    assert!(
        snapshot
            .last_indexed
            .unwrap()
            .file
            .unwrap()
            .ends_with(".rs")
    );
    fs::write(f.root.join("broken.rs"), [0xff]).unwrap();
    run(fixed as fn() -> Result<crate::embedding::Embedder>).unwrap();
    let partial = load(&f.root).unwrap().unwrap();
    let failure = partial.last_failure.unwrap();
    assert_eq!(failure.outcome, "incomplete");
    assert_eq!(failure.file.as_deref(), Some("broken.rs"));
    assert_ne!(
        partial.last_indexed.unwrap().file.as_deref(),
        Some("broken.rs")
    );
    fs::remove_file(f.root.join("broken.rs")).unwrap();
    fn unavailable() -> Result<crate::embedding::Embedder> {
        anyhow::bail!("model unavailable")
    }
    assert!(run(unavailable as fn() -> Result<crate::embedding::Embedder>).is_err());
    let failed = load(&f.root).unwrap().unwrap();
    assert_eq!(failed.last_failure.unwrap().component, "vectors_model");
    let history = failed
        .failures
        .iter()
        .map(|f| f.id.clone())
        .collect::<Vec<_>>();
    run(fixed as fn() -> Result<crate::embedding::Embedder>).unwrap();
    let recovered = load(&f.root).unwrap().unwrap();
    assert_eq!(
        history,
        recovered
            .failures
            .iter()
            .map(|f| f.id.clone())
            .collect::<Vec<_>>()
    );
    assert_eq!(recovered.components["vectors_model"].status, "observed");
}
#[test]
fn missing_corrupt_and_unwritable_status_do_not_hide_operation_results() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    assert_eq!(
        crate::commands::status::read(&root, now())["snapshot"],
        "missing"
    );
    assert!(!root.join(".mimirs").exists());
    directory(&root).unwrap();
    fs::write(path(&root), "broken").unwrap();
    assert_eq!(
        crate::commands::status::read(&root, now())["snapshot"],
        "unavailable"
    );
    let mut activity = Activity::start(&root, "learn", "knowledge");
    let result: Result<usize> = Ok(7);
    activity.result(&result);
    assert!(matches!(result, Ok(7)));
    assert_eq!(fs::read(path(&root)).unwrap(), b"broken");
    fs::remove_file(path(&root)).unwrap();
    fs::create_dir(path(&root)).unwrap();
    let mut activity = Activity::start(&root, "learn", "knowledge");
    activity.finish("success", None, Some("id"), Some("preview"));
    assert!(path(&root).is_dir());
}
#[test]
fn status_omits_multiline_dumps_and_recognizable_credentials() {
    let text = bounded(
        "request token=private-value password=hunter2 Bearer hidden-value https://user:pass@host/path ghp_abcdefghijk",
        384,
    );
    for secret in [
        "private-value",
        "hunter2",
        "hidden-value",
        "user:pass",
        "abcdefghijk",
    ] {
        assert!(!text.contains(secret), "{text}");
    }
    assert_eq!(
        bounded("parse failed\nsource body with secret", 384),
        "parse failed"
    );
}

#[test]
fn activity_instances_preserve_concurrent_owners_and_expire_honestly() {
    let t = tempfile::tempdir().unwrap();
    let root = t.path();
    let mut first = Activity::start(root, "watch", "source");
    let winner = load(root)
        .unwrap()
        .unwrap()
        .activities
        .keys()
        .next()
        .unwrap()
        .clone();
    let mut second = Activity::start(root, "watch", "source");
    let mut learn = Activity::start(root, "learn", "knowledge");
    let snapshot = load(root).unwrap().unwrap();
    assert_eq!(snapshot.activities.len(), 3);
    second.finish("failure", Some("another writer is active"), None, None);
    assert!(
        load(root)
            .unwrap()
            .unwrap()
            .activities
            .contains_key(&winner)
    );
    assert_eq!(
        crate::commands::status::read(root, now())["activities"][&winner]["state"],
        "observed_active"
    );
    assert_eq!(
        crate::commands::status::read(root, now() + LIVE_AGE_MS + 1000)["activities"][&winner]["state"],
        "unknown"
    );
    learn.finish("success", None, Some("claim"), Some("preview"));
    assert_eq!(load(root).unwrap().unwrap().activities.len(), 1);
    first.finish("success", None, None, None);
    let finished = load(root).unwrap().unwrap();
    assert!(finished.activities.is_empty());
    assert_eq!(finished.failures.len(), 1);
    assert_eq!(
        finished.last_learned.unwrap().claim.as_deref(),
        Some("claim")
    );
}
#[test]
fn concurrent_history_is_atomic_bounded_and_does_not_override_observations() {
    let t = tempfile::tempdir().unwrap();
    let root = t.path().canonicalize().unwrap();
    std::thread::scope(|scope| {
        let handles = (0..12)
            .map(|n| {
                let root = &root;
                scope.spawn(move || {
                    let mut activity = Activity::start(root, "review", "knowledge");
                    activity.finish("failure", Some(&format!("failure {n}")), None, None);
                })
            })
            .collect::<Vec<_>>();
        for h in handles {
            h.join().unwrap();
        }
    });
    assert_eq!(load(&root).unwrap().unwrap().failures.len(), 12);
    for _ in 0..8 {
        let mut a = Activity::start(&root, "review", "knowledge");
        a.finish("failure", Some("more history"), None, None);
    }
    let mut a = Activity::start(&root, "review", "knowledge");
    a.finish("success", None, None, None);
    let s = load(&root).unwrap().unwrap();
    assert_eq!(s.failures.len(), 16);
    assert_eq!(s.omitted_failures, 4);
    assert_eq!(s.recent.len(), 16);
    assert_eq!(s.components["knowledge"].status, "observed");
    assert!(fs::metadata(path(&root)).unwrap().len() < MAX_BYTES as u64);
}
#[test]
fn targets_and_disabled_observations_preserve_history_without_recovery_claims() {
    let t = tempfile::tempdir().unwrap();
    let root = t.path();
    let target = |repo: &str| {
        Some(Target {
            repository: Some(repo.into()),
            state: root.join(repo),
            default_branch: Some("main".into()),
        })
    };
    observation(
        root,
        "context-knowledge",
        "knowledge",
        "unavailable",
        target("a"),
        Some("bad journal"),
    );
    let bytes = fs::read(path(root)).unwrap();
    observation(
        root,
        "context-knowledge",
        "knowledge",
        "unavailable",
        target("a"),
        Some("bad journal"),
    );
    assert_eq!(bytes, fs::read(path(root)).unwrap());
    let history = load(root).unwrap().unwrap().failures[0].id.clone();
    for (repo, status) in [("b", "ok"), ("a", "ok"), ("a", "disabled")] {
        observation(
            root,
            "context-knowledge",
            "knowledge",
            status,
            target(repo),
            None,
        );
        let s = load(root).unwrap().unwrap();
        assert_eq!(s.failures[0].id, history);
        assert_eq!(s.failures.len(), 1);
        assert_eq!(s.components["knowledge"].status, status);
        assert_eq!(s.components["knowledge"].target, target(repo));
    }
}
#[test]
fn v1_snapshot_import_retains_history_without_resolution_or_health_claims() {
    let t = tempfile::tempdir().unwrap();
    let root = t.path();
    observation(
        root,
        "context-knowledge",
        "knowledge",
        "unavailable",
        None,
        Some("prior failure"),
    );
    let mut old = serde_json::to_value(load(root).unwrap().unwrap()).unwrap();
    old["version"] = json!(1);
    let event = old["failures"][0].clone();
    old["failures"] = json!({"old-key":{"event":event,"resolved_at":1}});
    fs::write(path(root), serde_json::to_vec(&old).unwrap()).unwrap();
    let before = fs::read(path(root)).unwrap();
    let view = crate::commands::status::read(root, now());
    assert_eq!(view["version"], 2);
    assert_eq!(view["failures"][0]["reason"], "prior failure");
    assert!(view["failures"][0].get("resolved_at").is_none());
    assert_eq!(view["components"]["knowledge"]["status"], "unconfigured");
    assert_eq!(
        load(root).unwrap().unwrap().components["knowledge"].status,
        "unknown"
    );
    assert_eq!(before, fs::read(path(root)).unwrap());
}
#[test]
fn active_registry_is_bounded_without_replacing_live_owners() {
    let t = tempfile::tempdir().unwrap();
    let mut activities = (0..18)
        .map(|_| Activity::start(t.path(), "learn", "knowledge"))
        .collect::<Vec<_>>();
    let s = load(t.path()).unwrap().unwrap();
    assert_eq!(s.activities.len(), 16);
    assert_eq!(s.omitted_activities, 2);
    let first = s.activities.keys().next().unwrap().clone();
    activities[17].finish("success", None, None, None);
    assert!(
        load(t.path())
            .unwrap()
            .unwrap()
            .activities
            .contains_key(&first)
    );
    for a in &mut activities {
        a.finish("success", None, None, None);
    }
}

#[test]
fn legacy_history_migrates_without_changing_legacy_bytes_and_canonical_wins() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let mut activity = Activity::start(&root, "old", "source");
    activity.finish("success", None, None, None);
    drop(activity);
    let legacy = root.join(".mimirs/status");
    fs::rename(path(&root), &legacy).unwrap();
    let bytes = fs::read(&legacy).unwrap();
    assert_eq!(
        load(&root)
            .unwrap()
            .unwrap()
            .last_success
            .unwrap()
            .operation,
        "old"
    );
    update(&root, |s| {
        s.observe("source", "observed", "new observation", now(), None)
    })
    .unwrap();
    assert_eq!(fs::read(&legacy).unwrap(), bytes);
    assert!(path(&root).is_file());
    fs::write(path(&root), "corrupt").unwrap();
    assert!(load(&root).is_err());
}

#[test]
fn migration_defers_for_a_held_legacy_owner_even_with_an_expired_heartbeat() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let mut activity = Activity::start(&root, "old", "source");
    let mut snapshot = load(&root).unwrap().unwrap();
    for active in snapshot.activities.values_mut() {
        active.heartbeat_at = 0;
    }
    let legacy = root.join(".mimirs/status");
    fs::write(&legacy, serde_json::to_vec(&snapshot).unwrap()).unwrap();
    fs::remove_file(path(&root)).unwrap();
    let bytes = fs::read(&legacy).unwrap();
    assert!(
        update(&root, |_| {})
            .unwrap_err()
            .to_string()
            .contains("deferred")
    );
    assert!(!path(&root).exists());
    assert_eq!(fs::read(&legacy).unwrap(), bytes);
    assert!(
        read(&root, now())["diagnostic"]
            .as_str()
            .unwrap()
            .contains("legacy")
    );
    activity.finish("success", None, None, None);
    drop(activity);
    update(&root, |s| {
        s.observe("source", "observed", "new observation", now(), None)
    })
    .unwrap();
    assert!(path(&root).exists());
    assert_eq!(fs::read(&legacy).unwrap(), bytes);
}

#[test]
fn customized_ignore_rules_must_cover_canonical_temporary_and_legacy_paths() {
    let dir = tempfile::tempdir().unwrap();
    assert!(
        std::process::Command::new("git")
            .args(["init", "-q"])
            .arg(dir.path())
            .status()
            .unwrap()
            .success()
    );
    fs::create_dir(dir.path().join(".mimirs")).unwrap();
    let ignore = dir.path().join(".mimirs/.gitignore");
    fs::write(&ignore, "status\nstatus.lock\nstatus-owners/\n").unwrap();
    assert!(
        directory(dir.path())
            .unwrap_err()
            .to_string()
            .contains("not ignored")
    );
    fs::write(
        &ignore,
        "status\nstatus.json\nstatus.json.tmp-*\nstatus.lock\nstatus-owners/\n",
    )
    .unwrap();
    let before = fs::read(&ignore).unwrap();
    directory(dir.path()).unwrap();
    assert_eq!(fs::read(ignore).unwrap(), before);
}
