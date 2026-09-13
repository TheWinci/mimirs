use crate::{analysis, source::SourceFile};
use serde_json::{Value, json};

fn cases() -> Vec<Value> {
    let reference: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/port/chunker/reference.json"
    ))
    .unwrap();
    reference["cases"].as_array().unwrap().clone()
}

fn source(case: &Value) -> String {
    let path = case["path"]
        .as_str()
        .unwrap()
        .replace("tests/fixtures/", "tests/fixtures/ts-v2-chunker/");
    let raw = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(path))
        .unwrap();
    let normalized = crate::source::normalized::Source::new(&raw);
    assert_eq!(normalized.text, case["source"].as_str().unwrap());
    normalized.text
}

fn check(language: &str) {
    let mut failures = Vec::new();
    let cases: Vec<_> = cases()
        .into_iter()
        .filter(|case| case["language"] == language)
        .collect();
    assert!(!cases.is_empty(), "no fixtures for {language}");
    for case in cases {
        let path = case["path"].as_str().unwrap();
        let result = analysis::extract(SourceFile {
            path: path.into(),
            text: source(&case),
        })
        .unwrap();
        crate::analysis::validation::validate(&result).unwrap();
        let actual: Vec<_> = result
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
        if json!(actual) != case["chunks"] {
            // Report all affected fixtures in one language, without flooding the
            // test output with the full trees. The first different node is enough.
            let expected = case["chunks"].as_array().unwrap();
            let difference = actual
                .iter()
                .zip(expected)
                .position(|(a, b)| a != b)
                .unwrap_or(actual.len().min(expected.len()));
            failures.push(format!(
                "{path}: node {difference}, actual {:?}, expected {:?}; lengths {}/{}",
                actual.get(difference),
                expected.get(difference),
                actual.len(),
                expected.len()
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

macro_rules! languages {
    ($($name:ident),+ $(,)?) => {$(
        #[test]
        fn $name() { check(stringify!($name)); }
    )+};
}

languages!(
    typescript, javascript, python, go, rust, java, c, cpp, csharp, ruby, php, scala, kotlin, lua,
    zig, elixir, bash, haskell, ocaml, dart, html, css, toml, yaml, markdown, text
);

fn facts(language: &str) {
    let cases: Vec<_> = cases()
        .into_iter()
        .filter(|case| case["language"] == language)
        .collect();
    assert!(!cases.is_empty(), "no fixtures for {language}");
    for case in cases {
        let path = case["path"].as_str().unwrap();
        let result = analysis::extract(SourceFile {
            path: path.into(),
            text: source(&case),
        })
        .unwrap();
        crate::analysis::validation::validate(&result).unwrap();
        assert_eq!(json!(result.source_facts), case["facts"], "{path}");
    }
}

#[test]
fn html_facts() {
    facts("html");
}
#[test]
fn css_facts() {
    facts("css");
}
#[test]
fn markdown_facts() {
    facts("markdown");
}
#[test]
fn bash_facts() {
    facts("bash");
}
#[test]
fn zig_facts() {
    facts("zig");
}
#[test]
fn lua_facts() {
    facts("lua");
}
#[test]
fn text_and_configuration_have_no_semantic_facts() {
    for language in ["text", "toml", "yaml"] {
        facts(language);
    }
}

#[test]
fn imported_chunker_fixtures_and_both_goldens_keep_their_original_hashes() {
    use sha2::{Digest, Sha256};
    let cases = cases();
    assert_eq!(cases.len(), 272);
    for case in cases {
        let path = case["path"].as_str().unwrap();
        let relative = path.strip_prefix("tests/fixtures/").unwrap();
        let (language, name) = relative.split_once('/').unwrap();
        let stem = name
            .rsplit_once('.')
            .unwrap()
            .0
            .strip_suffix(".d")
            .unwrap_or(name.rsplit_once('.').unwrap().0);
        for (path, hash_key) in [
            (
                format!("tests/fixtures/ts-v2-chunker/{relative}"),
                "sourceSha256",
            ),
            (
                format!("tests/goldens/ts-v2-chunker/trees/{language}/{stem}.tree.txt"),
                "treeGoldenSha256",
            ),
            (
                format!("tests/goldens/ts-v2-chunker/facts/{language}/{stem}.facts.txt"),
                "factGoldenSha256",
            ),
        ] {
            let bytes = std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(&path))
                .unwrap();
            let hash: String = Sha256::digest(bytes)
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect();
            assert_eq!(hash, case[hash_key].as_str().unwrap(), "{path}");
        }
    }
}

#[test]
fn python_facts() {
    facts("python");
}

#[test]
fn go_facts() {
    facts("go");
}

#[test]
fn c_facts() {
    facts("c");
}

#[test]
fn rust_facts() {
    facts("rust");
}

#[test]
fn javascript_facts() {
    facts("javascript");
}
#[test]
fn typescript_facts() {
    facts("typescript");
}

#[test]
fn java_facts() {
    facts("java");
}

#[test]
fn kotlin_facts() {
    facts("kotlin");
}

#[test]
fn ruby_facts() {
    facts("ruby");
}

#[test]
fn elixir_facts() {
    facts("elixir");
}

#[test]
fn haskell_facts() {
    facts("haskell");
}

#[test]
fn ocaml_facts() {
    facts("ocaml");
}

#[test]
fn scala_facts() {
    facts("scala");
}

#[test]
fn dart_facts() {
    facts("dart");
}

#[test]
fn php_facts() {
    facts("php");
}

#[test]
fn csharp_facts() {
    facts("csharp");
}

#[test]
fn cpp_facts() {
    facts("cpp");
}

#[test]
fn every_language_fact_survives_raw_offsets_and_storage_round_trips() {
    use analysis::source_facts::{Kind, Location};
    let dir = tempfile::tempdir().unwrap();
    let mut db = crate::storage::open(&dir.path().join("index.db"))
        .unwrap()
        .connection;
    for case in cases() {
        let path = case["path"].as_str().unwrap();
        let text = source(&case);
        let raw = format!("\u{feff}{}", text.replace('\n', "\r\n"));
        let normalized = crate::source::normalized::Source::new(&raw);
        let result = analysis::extract(SourceFile {
            path: path.into(),
            text: raw,
        })
        .unwrap();
        let mut expected: Vec<analysis::source_facts::Fact> =
            serde_json::from_value(case["facts"].clone()).unwrap();
        let lines = analysis::LineIndex::new(&result.source.text);
        let map = |location: &mut Location| {
            *location = Location::from_span(&lines.span(
                normalized.raw_offset(location.start_offset).unwrap(),
                normalized.raw_offset(location.end_offset).unwrap(),
            ));
        };
        for fact in &mut expected {
            map(&mut fact.location);
            if let Some(owner) = &mut fact.owner {
                map(&mut owner.location);
            }
            if let Kind::Call {
                target: Some(target),
                ..
            } = &mut fact.kind
            {
                map(&mut target.location);
            }
        }
        assert_eq!(result.source_facts, expected, "raw offsets {path}");
        let tx = db.transaction().unwrap();
        tx.execute("DELETE FROM files", []).unwrap();
        tx.execute("INSERT INTO files VALUES (1, ?1)", [path])
            .unwrap();
        crate::storage::analysis::write(&tx, 1, &result).unwrap();
        tx.commit().unwrap();
        assert_eq!(
            crate::storage::analysis::load(&db, path).unwrap().unwrap(),
            result,
            "stored {path}"
        );
    }
}

#[test]
fn text_fallback_preserves_whitespace_and_never_infers_semantics() {
    let result = analysis::extract(SourceFile {
        path: "spaced.txt".into(),
        text: "one\n  \n\t\ntwo".into(),
    })
    .unwrap();
    assert_eq!(
        result
            .source_chunks
            .iter()
            .map(|c| c.kind.as_str())
            .collect::<Vec<_>>(),
        ["paragraph", "gap", "paragraph"]
    );
    let gap = &result.source_chunks[1].span;
    assert_eq!(&result.source.text[gap.start..gap.end], "  \n\t\n");
    assert!(result.source_facts.is_empty());
    let empty = analysis::extract(SourceFile {
        path: "empty.txt".into(),
        text: String::new(),
    })
    .unwrap();
    assert!(empty.source_chunks.is_empty());
    assert!(empty.source_facts.is_empty());
    let log = analysis::extract(SourceFile {
        path: "single-line.log".into(),
        text: "import ./file; call(); https://example.com".into(),
    })
    .unwrap();
    assert_eq!(log.source_chunks.len(), 1);
    assert_eq!(log.source_chunks[0].kind, "paragraph");
    assert!(log.source_facts.is_empty());
}
