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
    assert!(String::from_utf8_lossy(&first.stdout).contains("result: failed"));
    assert_elapsed_time(&String::from_utf8_lossy(&first.stdout));
    assert!(!String::from_utf8_lossy(&first.stdout).contains("processing: {"));
    let saved = std::fs::read(&report).unwrap();
    let json: serde_json::Value = serde_json::from_slice(&saved).unwrap();
    assert_eq!(json["complete"], false);
    assert_eq!(json["version"], 3);
    assert!(json["queues"].is_object());
    assert!(json["error"].as_str().unwrap().contains("mimirs init"));
    assert!(json["phases_seconds"]["config"].is_number());
    assert!(!dir.path().join(".mimirs/config.toml").exists());
    assert!(!dir.path().join(".mimirs/index.db").exists());
    let status: serde_json::Value =
        serde_json::from_slice(&std::fs::read(dir.path().join(".mimirs/status.json")).unwrap())
            .unwrap();
    assert_eq!(status["last_failure"]["operation"], "index");
    assert!(status["last_success"].is_null());
    let second = invoke();
    assert!(!second.status.success());
    assert!(String::from_utf8_lossy(&second.stderr).contains("profile report already exists"));
    assert_eq!(std::fs::read(report).unwrap(), saved);
}

#[test]
fn unsupported_encoding_completes_with_readable_warnings_without_a_model() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join(".mimirs")).unwrap();
    std::fs::write(
        dir.path().join(".mimirs/config.toml"),
        "include = [\"*.css\"]\nexclude = []\n",
    )
    .unwrap();
    std::fs::write(dir.path().join("nonutf8.css"), [0xff, 0xfe]).unwrap();
    let cache = dir.path().join("unused-model-cache");
    let result = Command::new(env!("CARGO_BIN_EXE_mimirs"))
        .args(["index", "--model-cache"])
        .arg(&cache)
        .current_dir(dir.path())
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let text = String::from_utf8(result.stdout).unwrap();
    assert!(text.contains("result: complete with warnings"), "{text}");
    assert_elapsed_time(&text);
    assert!(text.contains("indexed: 0 files"));
    assert!(text.contains("skipped: 1 unsupported-encoding files"));
    assert!(text.contains("relationships: incomplete"));
    assert!(text.contains(".mimirs/watch/diagnostics.json"));
    assert!(!text.contains("processing: {"));
    assert!(result.stderr.len() < 500);
    assert!(!cache.exists());
    let details: serde_json::Value = serde_json::from_slice(
        &std::fs::read(dir.path().join(".mimirs/watch/diagnostics.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(details["counts"]["unsupported_encoding_files"], 1);
    assert_eq!(details["entries"][0]["path"], "nonutf8.css");
    assert_eq!(details["entries"][0]["kind"], "unsupported_encoding");
    assert_eq!(details["graph_coverage"], "incomplete");
}

fn assert_elapsed_time(output: &str) {
    let seconds = output
        .lines()
        .last()
        .and_then(|line| line.strip_prefix("time: "))
        .and_then(|line| line.strip_suffix(" seconds"))
        .unwrap_or_else(|| panic!("missing final elapsed time: {output}"));
    let elapsed: f64 = seconds.parse().unwrap();
    assert!(elapsed.is_finite() && elapsed >= 0.0, "{output}");
    assert_eq!(seconds.split_once('.').unwrap().1.len(), 2);
}
