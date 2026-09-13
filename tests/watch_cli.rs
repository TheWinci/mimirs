use std::{
    fs,
    path::Path,
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

fn command(root: &Path, args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_mimirs"))
        .current_dir(root)
        .args(args)
        .output()
        .unwrap()
}
struct Foreground(Child);
impl Drop for Foreground {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn wait_for(mut ready: impl FnMut() -> bool) {
    let start = Instant::now();
    while !ready() {
        assert!(
            start.elapsed() < Duration::from_secs(10),
            "watch did not reconcile"
        );
        thread::sleep(Duration::from_millis(10));
    }
}
fn inputs(root: &Path) -> Option<String> {
    let data = fs::read(root.join(".mimirs/watch/relationships.json")).ok()?;
    let value: serde_json::Value = serde_json::from_slice(&data).ok()?;
    value["inputs"].as_str().map(str::to_owned)
}
#[test]
fn foreground_observes_assets_exits_releases_writer_and_once_recovers() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    fs::create_dir(root.join(".mimirs")).unwrap();
    fs::write(
        root.join(".mimirs/config.toml"),
        "include = ['**/*.rs']\nexclude = ['**/.mimirs/**']\n",
    )
    .unwrap();
    // There is no selected source, so this exercises the real foreground CLI
    // and graph lifecycle without constructing an embedding backend.
    let mut watch = Foreground(
        Command::new(env!("CARGO_BIN_EXE_mimirs"))
            .current_dir(root)
            .args([
                "watch",
                "--interval-ms",
                "20",
                "--debounce-ms",
                "30",
                "--reconcile-ms",
                "200",
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    wait_for(|| inputs(root).is_some());
    let before = inputs(root).unwrap();
    fs::write(root.join("asset.bin"), [255, 0]).unwrap();
    wait_for(|| inputs(root).is_some_and(|key| key != before));
    assert!(watch.0.try_wait().unwrap().is_none());
    drop(watch);
    fs::remove_file(root.join("asset.bin")).unwrap();
    let stale = command(root, &["relationships", "--indexed", "--json"]);
    assert!(!stale.status.success());
    let once = command(root, &["watch", "--once"]);
    assert!(
        once.status.success(),
        "{}",
        String::from_utf8_lossy(&once.stderr)
    );
    let counters: serde_json::Value = serde_json::from_slice(&once.stdout).unwrap();
    assert_eq!(counters["analyzed"], 0);
    assert_eq!(counters["embedded_documents"], 0);
    let graph = command(root, &["relationships", "--indexed", "--json"]);
    assert!(
        graph.status.success(),
        "{}",
        String::from_utf8_lossy(&graph.stderr)
    );
    let status = command(root, &["watch", "--status"]);
    assert!(status.status.success());
    let status: serde_json::Value = serde_json::from_slice(&status.stdout).unwrap();
    assert_eq!(status["relationships"]["status"], "current");
    assert_eq!(
        status["knowledge"]["assessment"]["status"],
        "not_configured"
    );
    let idle = command(root, &["watch", "--once"]);
    assert!(idle.status.success());
    let counters: serde_json::Value = serde_json::from_slice(&idle.stdout).unwrap();
    assert_eq!(counters["graph_published"], false);
    assert_eq!(counters["state_published"], false);
}

#[test]
fn init_cannot_create_storage_while_another_process_holds_writer_ownership() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir(dir.path().join(".mimirs")).unwrap();
    let lock = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .open(dir.path().join(".mimirs/index.lock"))
        .unwrap();
    lock.try_lock().unwrap();
    let result = command(dir.path(), &["init"]);
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("another index writer"));
    assert!(!dir.path().join(".mimirs/index.db").exists());
}

#[test]
fn explicit_status_selection_stays_empty_and_relationships_survive_heartbeat() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    fs::create_dir(root.join(".mimirs")).unwrap();
    fs::write(root.join(".mimirs/.gitignore"), "*\n").unwrap();
    fs::write(root.join(".mimirs/config.toml"), "include=['.mimirs/status', '.mimirs/status-owners/**', '.mimirs/watch/**', '.mimirs/index.db*', '.mimirs/staging.db*']\nexclude=[]\n").unwrap();
    let once = command(root, &["watch", "--once"]);
    assert!(
        once.status.success(),
        "{}",
        String::from_utf8_lossy(&once.stderr)
    );
    let counters: serde_json::Value = serde_json::from_slice(&once.stdout).unwrap();
    assert_eq!(counters["indexed"], 0);
    assert!(
        command(root, &["relationships", "--indexed", "--json"])
            .status
            .success()
    );
    let mut watch = Foreground(
        Command::new(env!("CARGO_BIN_EXE_mimirs"))
            .current_dir(root)
            .args(["watch", "--interval-ms", "20", "--debounce-ms", "0"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let initial = fs::read(root.join(".mimirs/status")).unwrap();
    wait_for(|| fs::read(root.join(".mimirs/status")).is_ok_and(|v| v != initial));
    let started = fs::read(root.join(".mimirs/status")).unwrap();
    wait_for(|| fs::read(root.join(".mimirs/status")).is_ok_and(|v| v != started));
    assert!(watch.0.try_wait().unwrap().is_none());
    // Indexed readers themselves take writer ownership, so finish the watcher first.
    drop(watch);
    assert!(
        command(root, &["relationships", "--indexed", "--json"])
            .status
            .success()
    );
}

#[test]
fn losing_duplicate_watcher_keeps_the_live_instance_visible() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    fs::create_dir(root.join(".mimirs")).unwrap();
    fs::write(
        root.join(".mimirs/config.toml"),
        "include=['**/*.never']\nexclude=[]\n",
    )
    .unwrap();
    let mut watch = Foreground(
        Command::new(env!("CARGO_BIN_EXE_mimirs"))
            .current_dir(root)
            .args(["watch", "--interval-ms", "20", "--debounce-ms", "5000"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let status = || {
        let output = command(root, &["status", "--json"]);
        serde_json::from_slice::<serde_json::Value>(&output.stdout).unwrap()
    };
    wait_for(|| status()["index_writer"] == "held_at_observation");
    let loser = command(root, &["watch", "--once"]);
    assert!(!loser.status.success());
    assert!(String::from_utf8_lossy(&loser.stderr).contains("another index writer"));
    let view = status();
    assert!(
        view["activities"]
            .as_object()
            .unwrap()
            .values()
            .any(|a| a["pid"] == watch.0.id() && a["state"] == "observed_active")
    );
    assert!(watch.0.try_wait().unwrap().is_none());
}
