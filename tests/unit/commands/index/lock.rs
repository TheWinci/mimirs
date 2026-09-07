use super::*;

#[test]
fn lock_excludes_another_writer_and_releases_with_its_owner() {
    let root = tempfile::tempdir().unwrap();
    let first = acquire(root.path()).unwrap();
    assert!(acquire(root.path()).is_err());
    drop(first);
    let second = acquire(root.path()).unwrap();
    assert!(root.path().join(".mimirs/index.lock").exists());
    drop(second);
}

#[test]
fn killed_writer_releases_the_os_lock() {
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};
    let root = tempfile::tempdir().unwrap();
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "commands::index::lock::tests::lock_child",
            "--ignored",
            "--nocapture",
        ])
        .env("MIMIRS_TEST_LOCK_ROOT", root.path())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let start = Instant::now();
    while !root.path().join("ready").exists() && start.elapsed() < Duration::from_secs(5) {
        std::thread::sleep(Duration::from_millis(10));
    }
    let ready = root.path().join("ready").exists();
    let excluded = ready && acquire(root.path()).is_err();
    let _ = child.kill();
    child.wait().unwrap();
    assert!(ready && excluded, "child did not acquire the writer lock");
    acquire(root.path()).unwrap();
}

#[test]
#[ignore = "subprocess helper for killed_writer_releases_the_os_lock"]
fn lock_child() {
    let Ok(root) = std::env::var("MIMIRS_TEST_LOCK_ROOT") else {
        return;
    };
    let root = Path::new(&root);
    let _lock = acquire(root).unwrap();
    std::fs::write(root.join("ready"), "locked").unwrap();
    loop {
        std::thread::park();
    }
}
