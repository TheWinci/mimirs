use crate::{analysis, source::SourceFile};
use serde_json::{Value, json};

pub(super) fn cases() -> Vec<Value> {
    serde_json::from_str::<Value>(include_str!(
        "../../../tests/fixtures/port/relationships/reference.json"
    ))
    .unwrap()["cases"]
        .as_array()
        .unwrap()
        .clone()
}

pub(super) fn analyses(case: &Value) -> Vec<analysis::Analysis> {
    case["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|file| {
            let path = file["path"].as_str().unwrap();
            let fixture = format!(
                "tests/fixtures/ts-v2-relationships/{}/{}/{path}",
                case["suite"].as_str().unwrap(),
                case["project"].as_str().unwrap()
            );
            let raw = std::fs::read_to_string(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(fixture),
            )
            .unwrap();
            let normalized = crate::source::normalized::Source::new(&raw);
            assert_eq!(normalized.text, file["source"].as_str().unwrap());
            analysis::extract(SourceFile {
                path: path.into(),
                text: normalized.text,
            })
            .unwrap()
        })
        .collect()
}

fn check(suite: &str) {
    let cases: Vec<_> = cases()
        .into_iter()
        .filter(|case| case["suite"] == suite)
        .collect();
    assert!(!cases.is_empty());
    let mut failures = Vec::new();
    for case in cases {
        for (analysis, expected) in analyses(&case)
            .iter()
            .zip(case["files"].as_array().unwrap())
        {
            crate::analysis::validation::validate(analysis).unwrap();
            let actual: Vec<_> = analysis
                .source_chunks
                .iter()
                .map(|chunk| {
                    json!({
                        "kind": chunk.kind, "name": chunk.name, "parent": chunk.parent,
                        "start": chunk.span.start, "end": chunk.span.end,
                        "lineStart": chunk.span.line_start, "lineEnd": chunk.span.line_end,
                    })
                })
                .collect();
            for (kind, actual, expected) in [
                ("chunks", json!(actual), &expected["chunks"]),
                ("facts", json!(analysis.source_facts), &expected["facts"]),
            ] {
                if actual != *expected {
                    let actual = actual.as_array().unwrap();
                    let expected = expected.as_array().unwrap();
                    let index = actual
                        .iter()
                        .zip(expected)
                        .position(|(a, b)| a != b)
                        .unwrap_or(actual.len().min(expected.len()));
                    failures.push(format!(
                        "{suite}/{}/{} {kind} {index}, actual {:?}, expected {:?}; lengths {}/{}",
                        case["project"].as_str().unwrap(),
                        analysis.source.path,
                        actual.get(index),
                        expected.get(index),
                        actual.len(),
                        expected.len()
                    ));
                }
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

macro_rules! suites { ($($suite:ident),+ $(,)?) => {$ (#[test] fn $suite() { check(stringify!($suite)); })+}; }
suites!(
    typescript, javascript, python, go, rust, java, c, cpp, csharp, ruby, php, scala, kotlin, lua,
    zig, elixir, bash, haskell, ocaml, dart, html, css, markdown, toml, yaml, text, mixed
);

#[test]
fn all_relationship_projects_and_goldens_keep_original_hashes() {
    use sha2::{Digest, Sha256};
    let cases = cases();
    assert_eq!(cases.len(), 107);
    for case in cases {
        let relative = format!(
            "{}/{}",
            case["suite"].as_str().unwrap(),
            case["project"].as_str().unwrap()
        );
        let mut files: Vec<_> = case["fileHashes"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(path, hash)| {
                (
                    format!("tests/fixtures/ts-v2-relationships/{relative}/{path}"),
                    hash.as_str().unwrap(),
                )
            })
            .collect();
        files.push((
            format!("tests/goldens/ts-v2-relationships/{relative}.txt"),
            case["goldenSha256"].as_str().unwrap(),
        ));
        for (path, expected) in files {
            let bytes = std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(&path))
                .unwrap();
            let actual: String = Sha256::digest(bytes)
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect();
            assert_eq!(actual, expected, "{path}");
        }
    }
}

fn relationships(suite: &str) {
    let selected: Vec<_> = cases()
        .into_iter()
        .filter(|case| case["suite"] == suite)
        .collect();
    assert!(!selected.is_empty(), "missing relationship suite {suite}");
    for case in selected {
        let analyses = analyses(&case);
        let options = analysis::relationships::Options {
            go_module_path: case["goModulePath"].as_str().map(str::to_owned),
            project_paths: Some(
                case["projectPaths"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|p| p.as_str().unwrap().to_owned())
                    .collect(),
            ),
        };
        let actual = analysis::relationships::connect(&analyses, &options);
        assert_eq!(
            json!(actual),
            case["relationships"],
            "{suite}/{}",
            case["project"].as_str().unwrap()
        );
        let project = case["project"].as_str().unwrap();
        let golden =
            std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(
                format!("tests/goldens/ts-v2-relationships/{suite}/{project}.txt"),
            ))
            .unwrap();
        assert_eq!(
            analysis::relationships::render(&format!("{suite}/{project}"), &actual),
            golden.trim_end(),
            "relationship golden {suite}/{project}"
        );
    }
}

#[test]
fn ecmascript_relationships() {
    relationships("typescript");
    relationships("javascript");
}
#[test]
fn python_relationships() {
    relationships("python");
}
#[test]
fn go_relationships() {
    relationships("go");
}
#[test]
fn resource_relationships() {
    for suite in ["html", "css", "markdown", "text", "toml", "yaml"] {
        relationships(suite);
    }
}
#[test]
fn parses_plain_and_quoted_go_module_directives() {
    use analysis::relationships::parse_go_module;
    assert_eq!(
        parse_go_module("module example.com/plain\n\ngo 1.24\n").as_deref(),
        Some("example.com/plain")
    );
    assert_eq!(
        parse_go_module("// generated\nmodule \"example.com/quoted\"\n").as_deref(),
        Some("example.com/quoted")
    );
    assert_eq!(
        parse_go_module("module `example.com/raw`\n").as_deref(),
        Some("example.com/raw")
    );
    assert_eq!(parse_go_module("go 1.24\n"), None);
}

#[test]
fn direct_language_relationships() {
    for suite in ["bash", "zig", "lua", "c", "cpp"] {
        relationships(suite);
    }
}

#[test]
fn ruby_relationships() {
    relationships("ruby");
}
#[test]
fn haskell_relationships() {
    relationships("haskell");
}

#[test]
fn module_relationships() {
    relationships("elixir");
    relationships("ocaml");
}

#[test]
fn java_relationships() {
    relationships("java");
}
#[test]
fn csharp_relationships() {
    relationships("csharp");
}

#[test]
fn kotlin_relationships() {
    relationships("kotlin");
}
#[test]
fn scala_relationships() {
    relationships("scala");
}

#[test]
fn remaining_relationships() {
    for suite in ["dart", "php", "rust", "mixed", "text", "toml", "yaml"] {
        relationships(suite);
    }
}

#[test]
fn stored_relationships_match_direct_for_every_project() {
    let dir = tempfile::tempdir().unwrap();
    let mut db = crate::storage::open(&dir.path().join("index.db"))
        .unwrap()
        .connection;
    let cases = cases();
    assert_eq!(cases.len(), 107);
    for case in cases {
        let mut analyses = analyses(&case);
        let options = analysis::relationships::Options {
            go_module_path: case["goModulePath"].as_str().map(str::to_owned),
            project_paths: Some(
                case["projectPaths"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|p| p.as_str().unwrap().into())
                    .collect(),
            ),
        };
        let expected = analysis::relationships::connect(&analyses, &options);
        let tx = db.transaction().unwrap();
        tx.execute("DELETE FROM files", []).unwrap();
        for (id, a) in analyses.iter().enumerate() {
            tx.execute(
                "INSERT INTO files VALUES (?1,?2)",
                rusqlite::params![id as i64, a.source.path],
            )
            .unwrap();
            crate::storage::analysis::write(&tx, id as i64, a).unwrap();
        }
        tx.commit().unwrap();
        let stored: Vec<_> = analyses
            .iter()
            .map(|a| {
                crate::storage::analysis::load(&db, &a.source.path)
                    .unwrap()
                    .unwrap()
            })
            .collect();
        assert_eq!(
            analysis::relationships::connect(&stored, &options),
            expected,
            "stored {}/{}",
            case["suite"],
            case["project"]
        );
        analyses.reverse();
        assert_eq!(
            analysis::relationships::connect(&analyses, &options),
            expected,
            "reversed {}/{}",
            case["suite"],
            case["project"]
        );
    }
}

#[test]
fn ecmascript_extension_priority_and_declaration_fallback_match_ts_registry() {
    let input = [
        ("main.ts", "import './worker';\nimport './types';"),
        ("main.js", "import './worker';"),
        ("worker.tsx", "export function run() {}"),
        ("worker.mts", "export function run() {}"),
        ("worker.jsx", "export function run() {}"),
        ("worker.mjs", "export function run() {}"),
        ("types.d.ts", "export declare function run(): void;"),
    ];
    let analyses: Vec<_> = input
        .into_iter()
        .map(|(path, text)| {
            analysis::extract(SourceFile {
                path: path.into(),
                text: text.into(),
            })
            .unwrap()
        })
        .collect();
    let result = analysis::relationships::connect(&analyses, &Default::default());
    let targets: Vec<_> = result
        .imports
        .iter()
        .map(|r| (r.from_path.as_str(), r.to_path.as_str()))
        .collect();
    assert_eq!(
        targets,
        [
            ("main.js", "worker.mjs"),
            ("main.ts", "types.d.ts"),
            ("main.ts", "worker.mts")
        ]
    );
    assert!(result.unresolved_imports.is_empty());
}
