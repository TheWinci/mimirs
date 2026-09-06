use super::*;

fn build(path: &str, source: &str) -> Vec<Chunk> {
    let language = match path.rsplit('.').next().unwrap() {
        "rs" => "rust",
        "py" | "pyi" => "python",
        "tsx" => "tsx",
        "ts" => "typescript",
        "js" => "javascript",
        "go" => "go",
        _ => return text_chunks(source, path),
    };
    let grammar: tree_sitter::Language = match language {
        "rust" => tree_sitter_rust::LANGUAGE.into(),
        "python" => tree_sitter_python::LANGUAGE.into(),
        "javascript" => tree_sitter_javascript::LANGUAGE.into(),
        "typescript" => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
        "tsx" => tree_sitter_typescript::LANGUAGE_TSX.into(),
        "go" => tree_sitter_go::LANGUAGE.into(),
        _ => unreachable!(),
    };
    let mut parser = tree_sitter::Parser::new();
    parser.set_language(&grammar).unwrap();
    let tree = parser.parse(source, None).unwrap();
    from_tree(source, tree.root_node(), &grammar, language, &[]).unwrap()
}

#[test]
fn source_windows_match_ts_reference_before_inference() {
    let reference: serde_json::Value = serde_json::from_str(include_str!(
        "../../benchmarks/versions/port/reference.json"
    ))
    .unwrap();
    for case in reference["files"]
        .as_array()
        .unwrap()
        .iter()
        .chain(reference["sourceCases"].as_array().unwrap())
    {
        let path = case["path"].as_str().unwrap();
        let source = case["normalizedSource"].as_str().unwrap();
        let chunks = build(path, source);
        let windows = project(source, &chunks, 4000).unwrap();
        let expected = case["windows"].as_array().cloned().unwrap_or_else(|| {
            reference["windows"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|w| w["path"] == case["path"])
                .cloned()
                .collect()
        });
        assert_eq!(windows.len(), expected.len(), "{path}");
        let normalized = crate::retrieval::normalized::Source::new(source);
        for (window, expected) in windows.iter().zip(expected) {
            assert_eq!(
                &source[window.start..window.end],
                expected["text"].as_str().unwrap(),
                "{path}"
            );
            assert_eq!(
                normalized.utf16_offset(window.start).unwrap(),
                expected["startOffset"].as_u64().unwrap() as usize,
                "{path}"
            );
            assert_eq!(
                normalized.utf16_offset(window.end).unwrap(),
                expected["endOffset"].as_u64().unwrap() as usize,
                "{path}"
            );
            let chunk = &chunks[window.chunk];
            assert_eq!(
                chunk.kind,
                expected["sourceChunk"]["kind"].as_str().unwrap(),
                "{path}"
            );
            assert_eq!(
                chunk.name.as_deref(),
                expected["sourceChunk"]["name"].as_str(),
                "{path}"
            );
            assert_eq!(
                normalized.utf16_offset(chunk.span.start).unwrap(),
                expected["sourceChunk"]["startOffset"].as_u64().unwrap() as usize
            );
            assert_eq!(
                normalized.utf16_offset(chunk.span.end).unwrap(),
                expected["sourceChunk"]["endOffset"].as_u64().unwrap() as usize
            );
        }
    }
}

#[test]
fn native_grammars_preserve_leaf_coverage_and_parent_windows() {
    for (path, source) in [
        (
            "a.go",
            "package main\n\nimport \"fmt\"\n// Worker\ntype Worker struct { Name string }\nfunc (w *Worker) Run() { fmt.Println(w.Name) }\n",
        ),
        (
            "a.js",
            "import x from 'x';\nimport y from 'y';\nexport const run = () => x(y);\n",
        ),
        ("a.tsx", "export const View = () => <div>Hello</div>;\n"),
        (
            "a.ts",
            "function overload(a: string): string;\nfunction overload(a: any) { return a; }\n",
        ),
        (
            "a.md",
            "---\nname: test\n---\n# Top\n```\n# code\n```\n## Child\ntext\n",
        ),
    ] {
        let chunks = build(path, source);
        let mut coverage = vec![0; source.len()];
        for (id, chunk) in chunks.iter().enumerate() {
            if !chunks.iter().any(|c| c.parent == Some(id)) {
                for byte in &mut coverage[chunk.span.start..chunk.span.end] {
                    *byte += 1;
                }
            }
            if let Some(parent) = chunk.parent {
                assert!(parent < id);
                assert!(
                    chunks[parent].span.start <= chunk.span.start
                        && chunks[parent].span.end >= chunk.span.end
                );
            }
        }
        assert!(coverage.iter().all(|&count| count == 1), "{path}");
        let windows = project(source, &chunks, 30).unwrap();
        for (id, chunk) in chunks
            .iter()
            .enumerate()
            .filter(|(_, c)| c.parent.is_none() && c.kind != "gap")
        {
            let text = windows
                .iter()
                .filter(|w| w.chunk == id)
                .map(|w| &source[w.start..w.end])
                .collect::<String>();
            assert_eq!(text, source[chunk.span.start..chunk.span.end], "{path}");
        }
    }
}
