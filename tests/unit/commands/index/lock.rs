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
