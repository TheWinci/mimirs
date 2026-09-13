use super::*;
use crate::{embedding::DIMENSION, retrieval::split::TokenBudget, source::SourceFile};
use std::fs;

fn fixture(files: &[(&str, &str)]) -> (tempfile::TempDir, Connection, Response) {
    let root = tempfile::tempdir().unwrap();
    let mut db = storage::open(&root.path().join("index.db"))
        .unwrap()
        .connection;
    let budget = TokenBudget::new(crate::test_support::tokenizer(512)).unwrap();
    let policy = storage::policy::document_policy(&budget);
    let mut vector = vec![0.0; DIMENSION];
    vector[0] = 1.0;
    for (path, text) in files {
        let a = crate::analysis::extract(SourceFile {
            path: (*path).into(),
            text: (*text).into(),
        })
        .unwrap();
        let documents = crate::retrieval::ts_v2::documents(&a).unwrap();
        storage::documents::save(
            &mut db,
            &a,
            storage::documents::Batch {
                vectors: &vec![vector.clone(); documents.len()],
                documents: &documents,
                policy: &policy,
            },
        )
        .unwrap();
    }
    let response =
        storage::hybrid::search(&db, "read_config", Some(&vector), 100, &[], &policy).unwrap();
    (root, db, response)
}

fn evidence(output: &str) -> Vec<(Value, &str)> {
    let mut remaining = output;
    let mut result = Vec::new();
    while let Some(start) = remaining.find("\nevidence: ") {
        remaining = &remaining[start + "\nevidence: ".len()..];
        let (header, rest) = remaining.split_once("\ntext: ").unwrap();
        let header: Value = serde_json::from_str(header).unwrap();
        let count = header["text_bytes"].as_u64().unwrap() as usize;
        result.push((header, &rest[..count]));
        remaining = &rest[count..];
    }
    result
}

#[test]
fn citations_navigation_determinism_and_read_only_snapshot() {
    let files = [
        (
            "src/demo.rs",
            "fn read_config() { println!(\"café 😀\"); }\nfn helper() {}\n",
        ),
        ("src/other.rs", "fn read_config() {}\n"),
        ("guide.md", "Read [source](src/demo.rs) for read_config.\n"),
    ];
    let (root, db, response) = fixture(&files);
    let before = fs::read(root.path().join("index.db")).unwrap();
    let metadata = parity(&response);
    let output = render(&db, &response).unwrap();
    assert!(output.len() <= MAX_BYTES);
    assert_eq!(output, render(&db, &response).unwrap());
    assert_eq!(metadata, parity(&response));
    assert_eq!(before, fs::read(root.path().join("index.db")).unwrap());
    let paths: Vec<_> = output
        .lines()
        .filter(|s| s.starts_with("source "))
        .map(|s| serde_json::from_str::<Value>(s.split_once(": ").unwrap().1).unwrap())
        .collect();
    assert_eq!(paths.len(), response.source.len());
    for (nav, file) in paths.iter().zip(&response.source) {
        assert_eq!(nav["path"], file.hit.representative.path);
        assert_eq!(nav["score"].as_f64().unwrap(), file.hit.score);
        assert_eq!(nav["snapshot"], file.snapshot_hash);
    }
    assert!(output.contains("document 1:"));
    assert!(output.contains("reference navigation:"));
    let evidence = evidence(&output);
    assert!(!evidence.is_empty());
    for (header, text) in evidence {
        let file = &response.source[header["source_rank"].as_u64().unwrap() as usize - 1];
        let a = storage::analysis::load(&db, &file.hit.representative.path)
            .unwrap()
            .unwrap();
        let start = header["bytes"][0].as_u64().unwrap() as usize;
        let end = header["bytes"][1].as_u64().unwrap() as usize;
        assert_eq!(text, &a.source.text[start..end]);
        let span = LineIndex::new(&a.source.text).span(start, end);
        assert_eq!(header["lines"], json!([span.line_start, span.line_end]));
        let id = header["candidate"].as_i64().unwrap();
        assert!(file.blocks.iter().any(|b| {
            b.document.id == id
                && b.evidence
                    .iter()
                    .any(|e| e.span.start <= start && e.span.end >= end)
        }));
    }
}

#[test]
fn direct_leaves_follow_candidate_scores_and_container_stays_fallback() {
    let class = "class Client:\n    def early(self):\n        return 1\n    def read_config(self):\n        return 2\n";
    let (_, db, mut response) = fixture(&[
        ("client.py", class),
        ("functions.rs", "fn early() {}\nfn read_config() {}\n"),
    ]);
    let class_file = response
        .source
        .iter()
        .position(|f| f.hit.representative.path == "client.py")
        .unwrap();
    let selected = pieces(&db, &response).unwrap();
    let fallback: Vec<_> = selected.iter().filter(|p| p.file == class_file).collect();
    assert_eq!(fallback.len(), 1);
    assert!(fallback[0].leaf.is_none());
    assert!(!fallback[0].complete_leaf);
    assert_eq!(
        fallback[0].candidate.id,
        response.source[class_file].hit.representative.id
    );
    let functions = response
        .source
        .iter_mut()
        .find(|f| f.hit.representative.path == "functions.rs")
        .unwrap();
    for (index, b) in functions.blocks.iter_mut().enumerate() {
        b.document.semantic_rank = Some(if index == 0 { 100 } else { 1 });
        b.document.lexical_rank = None;
    }
    let selected = pieces(&db, &response).unwrap();
    let direct: Vec<_> = selected.iter().filter(|p| p.leaf.is_some()).collect();
    assert!(direct.len() >= 2);
    assert!(direct[0].text.contains("read_config"));
    assert!(
        render(&db, &response)
            .unwrap()
            .contains("representative fragment; not a complete leaf")
    );
}

#[test]
fn oversized_multibyte_lines_are_omitted_and_long_leaves_are_explicit_excerpts() {
    let huge = format!(
        "fn read_config() {{ let value = \"{}\"; }}",
        "😀".repeat(8000)
    );
    let multiline = format!(
        "fn read_config() {{\n{}}}\n",
        "    println!(\"café 😀\");\n".repeat(600)
    );
    let (_, db, response) = fixture(&[("huge.rs", &huge), ("long.rs", &multiline)]);
    let output = render(&db, &response).unwrap();
    assert!(output.len() <= MAX_BYTES);
    assert!(output.contains("evidence omitted:"));
    assert!(output.contains("partial leaf excerpt"));
    assert!(!output.contains("complete indexed leaf"));
    for (header, text) in evidence(&output) {
        assert!(text.ends_with('\n'));
        let f = &response.source[header["source_rank"].as_u64().unwrap() as usize - 1];
        let a = storage::analysis::load(&db, &f.hit.representative.path)
            .unwrap()
            .unwrap();
        let start = header["bytes"][0].as_u64().unwrap() as usize;
        let end = header["bytes"][1].as_u64().unwrap() as usize;
        assert_eq!(&a.source.text[start..end], text);
        let span = LineIndex::new(&a.source.text).span(start, end);
        assert_eq!(header["lines"], json!([span.line_start, span.line_end]));
        assert!(start == 0 || a.source.text.as_bytes()[start - 1] == b'\n');
    }
}

#[test]
fn five_body_limit_retains_all_file_navigation_and_empty_results() {
    let files: Vec<_> = (0..8)
        .map(|n| (format!("f{n}.rs"), "fn read_config() {}\n"))
        .collect();
    let refs: Vec<_> = files.iter().map(|(p, t)| (p.as_str(), *t)).collect();
    let (_, db, response) = fixture(&refs);
    let output = render(&db, &response).unwrap();
    assert_eq!(
        output.lines().filter(|s| s.starts_with("source ")).count(),
        8
    );
    assert_eq!(evidence(&output).len(), 5);
    assert_eq!(pieces(&db, &response).unwrap().len(), 5);
    let empty = Response {
        source: vec![],
        docs: vec![],
        relations: vec![],
    };
    let out = render(&db, &empty).unwrap();
    assert!(out.contains("results: 0"));
    assert!(out.contains("evidence is partial"));
    assert!(out.len() < MAX_BYTES);
}

#[test]
fn navigation_overflow_fails_without_dropping_paths() {
    let long_path = format!("{}.rs", "p".repeat(MAX_BYTES));
    let (_, db, response) = fixture(&[(&long_path, "fn read_config() {}\n")]);
    let error = render(&db, &response).unwrap_err().to_string();
    assert_eq!(
        error,
        "compact navigation exceeds 16000 UTF-8 bytes; use full output or a smaller limit"
    );
    assert!(error.len() < MAX_BYTES);
}

#[test]
fn python_direct_function_is_a_complete_leaf() {
    let source = "def read_config():\n    return 'café 😀'\n";
    let (_, db, response) = fixture(&[("config.py", source)]);
    let selected = pieces(&db, &response).unwrap();
    assert_eq!(selected.len(), 1);
    assert_eq!(selected[0].kind, "function");
    assert!(selected[0].leaf.is_some());
    assert!(selected[0].complete_leaf);
    let output = render(&db, &response).unwrap();
    let emitted = evidence(&output);
    assert_eq!(emitted.len(), 1);
    assert_eq!(emitted[0].0["status"], "complete indexed leaf");
    assert_eq!(emitted[0].1, source);
}

#[test]
fn direct_callables_allow_internal_comments_blocks_and_local_statements() {
    for (path, source, name) in [
        (
            "body.rs",
            "fn read_config(flag: bool) -> usize {\n    // retain the local branch\n    let value = if flag { 1 } else { 2 };\n    if value > 0 {\n        return value;\n    }\n    0\n}\n",
            "read_config",
        ),
        (
            "body.py",
            "def read_config(flag):\n    # retain the local branch\n    value = 1 if flag else 2\n    if value > 0:\n        return value\n    return 0\n",
            "read_config",
        ),
        (
            "method.py",
            "class Client:\n    def read_config(self, flag):\n        # retain the local branch\n        value = 1 if flag else 2\n        if value > 0:\n            return value\n        return 0\n",
            "read_config",
        ),
        (
            "method.rs",
            "struct Client;\nimpl Client {\n    fn read_config(&self, flag: bool) -> usize {\n        // retain the local branch\n        let value = if flag { 1 } else { 2 };\n        if value > 0 { return value; }\n        0\n    }\n}\n",
            "read_config",
        ),
    ] {
        let a = crate::analysis::extract(SourceFile {
            path: path.into(),
            text: source.into(),
        })
        .unwrap();
        let (id, chunk) = a
            .source_chunks
            .iter()
            .enumerate()
            .find(|(_, c)| {
                c.name.as_deref() == Some(name) && matches!(c.kind.as_str(), "function" | "method")
            })
            .unwrap();
        assert!(
            a.source_chunks
                .iter()
                .any(|c| c.parent == Some(id) && c.kind != "gap"),
            "fixture must exercise internal segmentation: {path}"
        );
        // Model a directly returned candidate for this real parsed callable.
        // This does not infer that retrieval would choose a method from a class hit.
        let c = Candidate {
            source_chunk: Some(id),
            id: 7,
            file_id: 1,
            ordinal: 0,
            owner: chunk.owner,
            path: path.into(),
            start: chunk.span.start,
            end: chunk.span.end,
            semantic_score: Some(0.7),
            lexical_score: None,
            semantic_rank: Some(3),
            lexical_rank: None,
        };
        let leaf = direct_leaf(&a, &c)
            .unwrap()
            .expect("internal blocks must not exclude a callable");
        assert_eq!(leaf.2, &chunk.span);
        let piece = Piece::new(0, &c, &a, &chunk.span, Some(leaf))
            .unwrap()
            .unwrap();
        assert_eq!(piece.candidate.score(), c.score());
        assert!(piece.complete_leaf);
        assert_eq!(piece.text, a.source.text[chunk.span.start..chunk.span.end]);
        assert!(piece.pack(MAX_BYTES).contains("complete indexed leaf"));
        if let Some(owner) = c.owner {
            let mut owner_candidate = c.clone();
            owner_candidate.source_chunk = None;
            let leaf = direct_leaf(&a, &owner_candidate)
                .unwrap()
                .expect("direct callable owner remains eligible");
            assert_eq!(leaf.2, &a.entities[owner].span);
        }
    }
}

#[test]
fn nested_named_callables_still_disqualify_outer_direct_candidate() {
    for (path, source) in [
        (
            "nested.py",
            "def read_config():\n    def nested():\n        return 1\n    return nested()\n",
        ),
        (
            "nested.rs",
            "fn read_config() {\n    fn nested() {}\n    nested();\n}\n",
        ),
    ] {
        let a = crate::analysis::extract(SourceFile {
            path: path.into(),
            text: source.into(),
        })
        .unwrap();
        let (id, chunk) = a
            .source_chunks
            .iter()
            .enumerate()
            .find(|(_, c)| c.name.as_deref() == Some("read_config"))
            .unwrap();
        let c = Candidate {
            source_chunk: Some(id),
            id: 7,
            file_id: 1,
            ordinal: 0,
            owner: chunk.owner,
            path: path.into(),
            start: chunk.span.start,
            end: chunk.span.end,
            semantic_score: Some(0.7),
            lexical_score: None,
            semantic_rank: Some(3),
            lexical_rank: None,
        };
        assert!(direct_leaf(&a, &c).unwrap().is_none());
    }
}
