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
            "storage::writer::tests::lock_child",
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

#[test]
fn guard_release_does_not_wait_for_a_duplicated_child_descriptor() {
    let root = tempfile::tempdir().unwrap();
    let owner = acquire(root.path()).unwrap();
    // A concurrent fork can temporarily retain the same open-file description.
    let inherited = owner.0.try_clone().unwrap();
    drop(owner);
    let next = acquire(root.path()).unwrap();
    drop(inherited);
    assert!(acquire(root.path()).is_err());
    drop(next);
    acquire(root.path()).unwrap();
}
