use serde_json::Value;
use std::{fs, path::Path, process::Command};

fn run(root: &Path, args: &[&str]) -> String {
    let output = Command::new(env!("CARGO_BIN_EXE_mimirs"))
        .current_dir(root)
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

#[test]
#[ignore = "loads the cached q8 model for focused native-language lifecycle checks"]
fn native_language_search_uses_saved_source_and_reuses_unchanged_files() {
    let reference: Value = serde_json::from_str(include_str!(
        "../benchmarks/versions/port/languages/reference.json"
    ))
    .unwrap();
    let selected = std::env::var("MIMIRS_TEST_LANGUAGE").unwrap_or_else(|_| "java".into());
    for case in reference["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|case| case["language"] == selected)
    {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let path = case["path"].as_str().unwrap();
        fs::write(root.join(path), case["source"].as_str().unwrap()).unwrap();
        fs::write(
            root.join("distractor.rs"),
            "/// Draw a blue triangle.\nfn draw_triangle() {}\n",
        )
        .unwrap();
        run(root, &["init"]);
        let config = fs::read(root.join(".mimirs/config.toml")).unwrap();
        run(root, &["index"]);
        assert_eq!(fs::read(root.join(".mimirs/config.toml")).unwrap(), config);
        let direct = run(root, &["inspect", path, "--source-chunks"]);
        assert_eq!(
            direct,
            run(root, &["inspect", path, "--source-chunks", "--stored"])
        );
        let results = run(root, &["search", "restore café archives", "--limit", "1"]);
        assert!(results.contains(path), "{selected}: {results}");
        run(root, &["index", "--profile", "unchanged.json"]);
        let profile: Value =
            serde_json::from_slice(&fs::read(root.join("unchanged.json")).unwrap()).unwrap();
        assert_eq!(
            profile["counters"]["embedding_calls"].as_u64().unwrap_or(0),
            0,
            "{profile}"
        );
        fs::remove_file(root.join(path)).unwrap();
        assert_eq!(
            direct,
            run(root, &["inspect", path, "--source-chunks", "--stored"])
        );
        run(root, &["index"]);
        assert!(!run(root, &["search", "restore café archives", "--limit", "5"]).contains(path));
    }
}
