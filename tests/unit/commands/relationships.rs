use super::*;
use std::fs;

fn put(root: &Path, path: &str, contents: impl AsRef<[u8]>) {
    let path = root.join(path);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, contents).unwrap();
}

#[test]
fn connects_project_code_and_binary_assets_without_setup_or_model() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    put(
        root,
        "entry.ts",
        "import { run } from './worker';\nrun();\n",
    );
    put(root, "worker.ts", "export function run() {}\n");
    put(root, "index.html", "<img src=\"image.png\">\n");
    put(root, "image.png", [255, 0, 128]);
    let result = analyze(root).unwrap();
    assert!(
        result
            .imports
            .iter()
            .any(|r| r.from_path == "entry.ts" && r.to_path == "worker.ts")
    );
    assert!(
        result
            .imports
            .iter()
            .any(|r| r.from_path == "index.html" && r.to_path == "image.png")
    );
    assert!(
        result
            .calls
            .iter()
            .any(|r| r.to_path == "worker.ts" && r.to.name == "run")
    );
    assert!(!root.join(".mimirs").exists());
    assert_eq!(result, analyze(root).unwrap());
}

#[test]
fn respects_config_and_reports_missing_targets_after_edits() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    put(
        root,
        ".mimirs/config.toml",
        "include = ['**/*.ts']\nexclude = ['excluded/**']\n",
    );
    put(
        root,
        "entry.ts",
        "import { run } from './worker';\nrun();\n",
    );
    put(root, "worker.ts", "export function run() {}\n");
    put(root, "excluded/invalid.ts", [255]);
    put(root, "not-selected.py", [255]);
    assert_eq!(analyze(root).unwrap().calls.len(), 1);
    fs::remove_file(root.join("worker.ts")).unwrap();
    let result = analyze(root).unwrap();
    assert!(result.calls.is_empty());
    assert_eq!(result.unresolved_imports.len(), 1);
    assert_eq!(result.unresolved_calls.len(), 1);
    assert!(!root.join(".mimirs/index.db").exists());
}

#[test]
fn reads_go_module_metadata_and_reports_invalid_configuration() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    put(root, "go.mod", "module \"example.com/project\"\n");
    put(
        root,
        "main.go",
        "package main\nimport \"example.com/project/worker\"\nfunc main() { worker.Run() }\n",
    );
    put(root, "worker/work.go", "package worker\nfunc Run() {}\n");
    let result = analyze(root).unwrap();
    assert!(
        result
            .imports
            .iter()
            .any(|r| r.to_path == "worker" && r.target_kind == "package")
    );
    assert!(
        result
            .calls
            .iter()
            .any(|r| r.to_path == "worker/work.go" && r.to.name == "Run")
    );
    put(root, ".mimirs/config.toml", "broken = [");
    assert!(analyze(root).is_err());
}
