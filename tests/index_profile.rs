use std::process::Command;

#[test]
fn failed_index_writes_an_incomplete_profile_and_never_overwrites_it() {
    let dir = tempfile::tempdir().unwrap();
    let report = dir.path().join("profile.json");
    let invoke = || {
        Command::new(env!("CARGO_BIN_EXE_mimirs"))
            .args(["index", "--profile"])
            .arg(&report)
            .current_dir(dir.path())
            .output()
            .unwrap()
    };
    let first = invoke();
    assert!(!first.status.success());
    assert!(first.stdout.is_empty());
    let saved = std::fs::read(&report).unwrap();
    let json: serde_json::Value = serde_json::from_slice(&saved).unwrap();
    assert_eq!(json["complete"], false);
    assert_eq!(json["version"], 2);
    assert!(json["error"].as_str().unwrap().contains("mimirs init"));
    assert!(json["phases_seconds"]["config"].is_number());
    assert!(!dir.path().join(".mimirs").exists());
    let second = invoke();
    assert!(!second.status.success());
    assert!(String::from_utf8_lossy(&second.stderr).contains("profile report already exists"));
    assert_eq!(std::fs::read(report).unwrap(), saved);
}
