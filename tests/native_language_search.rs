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
        "../tests/fixtures/port/languages/reference.json"
    ))
    .unwrap();
    let selected = std::env::var("MIMIRS_TEST_LANGUAGE").unwrap_or_else(|_| "java".into());
    for case in reference["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|case| {
            case["language"] == selected && case["path"].as_str().unwrap().starts_with("archive.")
        })
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
        // Profiles contain source filenames. Keep generated test artifacts out
        // of the corpus so a deletion check cannot retrieve the profile itself.
        run(root, &["index", "--profile", ".mimirs/unchanged.json"]);
        let profile: Value =
            serde_json::from_slice(&fs::read(root.join(".mimirs/unchanged.json")).unwrap())
                .unwrap();
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
        let db = rusqlite::Connection::open(root.join(".mimirs/index.db")).unwrap();
        assert_eq!(
            db.query_row("SELECT count(*) FROM files WHERE path=?1", [path], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert!(!run(root, &["search", "restore café archives", "--limit", "5"]).contains(path));
    }
}

#[test]
#[ignore = "loads the cached q8 model for the v1 fallback-format retrieval check"]
fn fallback_formats_are_searchable_with_exact_saved_evidence() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let paths = [
        "archive.swift",
        "archive.fish",
        "archive.tf",
        "archive.proto",
        "archive.graphql",
        "archive.gql",
        "archive.mod",
        "archive.xml",
        "archive.json",
        "archive.sql",
        "archive.bru",
        "archive.scss",
        "archive.less",
        "archive.zon",
        "archive.zsh",
        "archive.lhs",
        "Dockerfile.dev",
        "Jenkinsfile.prod",
        "GNUmakefile",
        "Vagrantfile",
        "Gemfile",
        "Rakefile",
        "Brewfile",
        "Procfile",
        "guide.mdx",
    ];
    let labels = [
        "apricot",
        "birch",
        "cobalt",
        "dahlia",
        "emerald",
        "fennel",
        "ginger",
        "hazel",
        "indigo",
        "juniper",
        "kiwi",
        "lavender",
        "magnolia",
        "nectarine",
        "orchid",
        "paprika",
        "quartz",
        "rosemary",
        "sapphire",
        "tamarind",
        "umber",
        "violet",
        "willow",
        "xenon",
        "zinnia",
    ];
    for (index, path) in paths.iter().enumerate() {
        fs::write(
            root.join(path),
            format!(
                "# {} archive\r\n\r\nRestore {} café archive manifests.\r\n",
                labels[index], labels[index]
            ),
        )
        .unwrap();
    }
    fs::write(root.join("unrelated.rs"), "fn draw_triangle() {}\n").unwrap();
    run(root, &["init"]);
    run(root, &["index"]);
    for (index, path) in paths.iter().enumerate() {
        let direct = run(root, &["inspect", path, "--source-chunks"]);
        assert_eq!(
            direct,
            run(root, &["inspect", path, "--source-chunks", "--stored"])
        );
        let result = run(
            root,
            &[
                "search",
                &format!("restore {} archive", labels[index]),
                "--limit",
                "5",
            ],
        );
        assert!(result.contains(path), "{path}: {result}");
        let previews: Value = serde_json::from_str(&direct).unwrap();
        let source = fs::read_to_string(root.join(path)).unwrap();
        for preview in previews.as_array().unwrap() {
            let start = preview["span"]["start"].as_u64().unwrap() as usize;
            let end = preview["span"]["end"].as_u64().unwrap() as usize;
            assert_eq!(preview["text"], &source[start..end]);
        }
    }
}
