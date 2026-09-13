//! Unmodified TS fixtures and goldens, exercised through production dispatch.
use super::*;
use crate::{analysis, source::SourceFile, source::normalized::Source};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{collections::BTreeSet, path::Path};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    path: String,
    golden: String,
    source_sha256: String,
    golden_sha256: String,
    chunks: Value,
    projections: Vec<Projection>,
}

#[derive(Deserialize)]
struct Projection {
    target: usize,
    windows: Value,
}

fn cases() -> Vec<Case> {
    #[derive(Deserialize)]
    struct Reference {
        cases: Vec<Case>,
    }
    serde_json::from_str::<Reference>(include_str!(
        "../../../tests/fixtures/port/source-windows/reference.json"
    ))
    .unwrap()
    .cases
}

fn read(path: &str) -> String {
    std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join(path)).unwrap()
}

fn span(source: &Source, raw: &crate::analysis::Span) -> Value {
    json!({
        "start": source.normalized_offset(raw.start).unwrap(),
        "end": source.normalized_offset(raw.end).unwrap(),
        "lineStart": raw.line_start, "lineEnd": raw.line_end,
    })
}

fn check(case: &Case, raw: &str, render_golden: bool) {
    let source = Source::new(raw);
    let analysis = analysis::extract(SourceFile {
        path: case.path.clone(),
        text: raw.into(),
    })
    .unwrap();
    crate::analysis::validation::validate(&analysis).unwrap();
    let chunks = &analysis.source_chunks;
    let actual: Vec<_> = chunks
        .iter()
        .map(|chunk| {
            let mut value = span(&source, &chunk.span);
            value["kind"] = json!(chunk.kind);
            value["name"] = json!(chunk.name);
            value["parent"] = json!(chunk.parent);
            value
        })
        .collect();
    assert_eq!(json!(actual), case.chunks, "{} chunk tree", case.path);

    // Every leaf covers its exact share of normalized source, including gaps.
    let mut cursor = 0;
    for (id, chunk) in chunks.iter().enumerate() {
        if !chunks.iter().any(|child| child.parent == Some(id)) {
            assert_eq!(source.normalized_offset(chunk.span.start).unwrap(), cursor);
            cursor = source.normalized_offset(chunk.span.end).unwrap();
        }
    }
    assert_eq!(cursor, source.text.len(), "{} leaf coverage", case.path);

    let lines = analysis::LineIndex::new(raw);
    for projection in &case.projections {
        let windows = project(raw, chunks, projection.target).unwrap();
        let actual: Vec<_> = windows
            .iter()
            .map(|window| {
                let mut value = span(&source, &lines.span(window.start, window.end));
                value["chunk"] = json!(window.chunk);
                value
            })
            .collect();
        assert_eq!(
            json!(actual),
            projection.windows,
            "{} target {}",
            case.path,
            projection.target
        );
        for window in &windows {
            assert_ne!(chunks[window.chunk].kind, "gap");
            assert!(chunks[window.chunk].parent.is_none());
            assert!(!raw[window.start..window.end].trim().is_empty());
        }
        for (id, chunk) in chunks
            .iter()
            .enumerate()
            .filter(|(_, c)| c.parent.is_none() && c.kind != "gap")
        {
            let owned: Vec<_> = windows.iter().filter(|w| w.chunk == id).collect();
            assert!(!owned.is_empty());
            assert_eq!(owned[0].start, chunk.span.start);
            assert_eq!(owned.last().unwrap().end, chunk.span.end);
            let text: String = owned.iter().map(|w| &raw[w.start..w.end]).collect();
            assert_eq!(text, raw[chunk.span.start..chunk.span.end]);
            for pair in owned.windows(2) {
                assert_eq!(pair[0].end, pair[1].start);
                let start = raw[..pair[1].start].rfind('\n').map_or(0, |i| i + 1);
                let prefix = &raw[start..pair[1].start];
                assert!(prefix.is_empty() || !prefix.trim().is_empty());
            }
        }
        if render_golden && projection.target == case.projections[0].target {
            assert_eq!(
                render(&case.path, raw, chunks, &windows),
                read(&case.golden).trim_end(),
                "{} reviewed golden",
                case.path
            );
        }
    }
}

// This is only the archived display format. Chunking and preview behavior come
// from production code; no projection algorithm is reproduced in the test.
fn render(path: &str, source: &str, chunks: &[Chunk], windows: &[windows::Window]) -> String {
    let lines = analysis::LineIndex::new(source);
    let range = |start, end| {
        if start == end {
            format!("{start}")
        } else {
            format!("{start}–{end}")
        }
    };
    let groups: Vec<_> = windows.chunk_by(|a, b| a.chunk == b.chunk).collect();
    let mut output = vec![path.to_owned()];
    for (index, group) in groups.iter().enumerate() {
        let last = index + 1 == groups.len();
        let chunk = &chunks[group[0].chunk];
        let name = chunk.name.as_ref().map_or(String::new(), |name| {
            format!(" {}", name.split_whitespace().collect::<Vec<_>>().join(" "))
        });
        output.push(format!(
            "{} {}{name} [{}]",
            if last { "└──" } else { "├──" },
            chunk.kind,
            range(chunk.span.line_start, chunk.span.line_end),
        ));
        for (index, window) in group.iter().enumerate() {
            let text = &source[window.start..window.end];
            let span = lines.span(window.start, window.end);
            output.push(format!(
                "{}{} window [{}] ({} chars) “{}”",
                if last { "    " } else { "│   " },
                if index + 1 == group.len() {
                    "└──"
                } else {
                    "├──"
                },
                range(span.line_start, span.line_end),
                text.encode_utf16().count(),
                crate::storage::hybrid::preview(text, 96),
            ));
        }
    }
    output.join("\n")
}

fn language(language: &str) {
    let cases: Vec<_> = cases()
        .into_iter()
        .filter(|case| {
            case.path
                .starts_with(&format!("tests/fixtures/source-windows/{language}/"))
        })
        .collect();
    assert!(!cases.is_empty(), "missing fixtures for {language}");
    for case in cases {
        let source = read(&case.path);
        check(&case, &source, true);
        // Fresh parser and projection must reproduce the same reference.
        check(&case, &source, false);
        check(
            &case,
            &format!("\u{feff}{}", source.replace('\n', "\r\n")),
            false,
        );
    }
}

macro_rules! languages {
    ($($name:ident),+ $(,)?) => {$(
        #[test]
        fn $name() { language(stringify!($name)); }
    )+};
}

languages!(
    typescript, javascript, python, go, rust, java, c, cpp, csharp, ruby, php, scala, kotlin, lua,
    zig, elixir, bash, haskell, ocaml, dart, html, css, toml, yaml, markdown, text,
);

#[test]
fn every_archived_fixture_and_golden_is_checked_without_changes() {
    use sha2::{Digest, Sha256};
    let cases = cases();
    assert_eq!(cases.len(), 84);
    let reference: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/port/source-windows/reference.json"
    ))
    .unwrap();
    for extension in reference["extensions"].as_array().unwrap() {
        let extension = extension.as_str().unwrap();
        assert!(
            cases.iter().any(|case| case.path.ends_with(extension)),
            "{extension}"
        );
        assert!(
            analysis::language::for_path(&format!("example{extension}")).is_native,
            "{extension}"
        );
    }
    for (directory, golden) in [
        ("tests/fixtures/source-windows", false),
        ("tests/goldens/source-windows", true),
    ] {
        let expected: BTreeSet<_> = cases
            .iter()
            .map(|case| if golden { &case.golden } else { &case.path })
            .cloned()
            .collect();
        assert_eq!(expected.len(), cases.len());
        let mut actual = BTreeSet::new();
        for language in
            std::fs::read_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join(directory)).unwrap()
        {
            for file in std::fs::read_dir(language.unwrap().path()).unwrap() {
                let path = file.unwrap().path();
                actual.insert(
                    path.strip_prefix(env!("CARGO_MANIFEST_DIR"))
                        .unwrap()
                        .to_str()
                        .unwrap()
                        .to_owned(),
                );
            }
        }
        assert_eq!(actual, expected);
    }
    for case in cases {
        let hash = |path: &str| {
            Sha256::digest(read(path))
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        };
        assert_eq!(hash(&case.path), case.source_sha256, "{}", case.path);
        assert_eq!(hash(&case.golden), case.golden_sha256, "{}", case.golden);
        assert_eq!(case.projections.len(), 3);
        assert_eq!(case.projections[1].target, 80);
        assert_eq!(case.projections[2].target, 4000);
    }
}

#[test]
fn preview_and_soft_target_edges_match_ts() {
    let source = read("tests/fixtures/source-windows/typescript/small-function.ts");
    assert_eq!(
        crate::storage::hybrid::preview(&source, 32),
        "/** Format one user for display…"
    );
    let source = format!("export const value = \"{}\";\n", "x".repeat(80));
    let analysis = analysis::extract(SourceFile {
        path: "long-line.ts".into(),
        text: source.clone(),
    })
    .unwrap();
    let windows = project(&source, &analysis.source_chunks, 20).unwrap();
    assert_eq!(windows.len(), 1);
    assert_eq!(&source[windows[0].start..windows[0].end], source);
    assert!(project(&source, &analysis.source_chunks, 0).is_err());
}
