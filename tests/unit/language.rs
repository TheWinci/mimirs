use super::*;

#[test]
fn dispatch_preserves_rust_and_text_fallback() {
    for path in ["main.rs", "src/café.rs", "/tmp/project/lib.rs"] {
        assert_eq!(
            for_path(path).identity,
            super::super::rust::LANGUAGE.identity
        );
    }
    for path in [
        "main.unknown",
        "main.RS",
        "notes.md",
        "README",
        "rs",
        "file.rs.txt",
    ] {
        assert_eq!(
            for_path(path).identity,
            super::super::text::LANGUAGE.identity
        );
        let analysis = (for_path(path).extract)(SourceFile {
            path: path.into(),
            text: "fn looks_like_rust() {}".into(),
        })
        .unwrap();
        assert!(analysis.entities.is_empty());
        assert!(super::super::report(&analysis).contains("not parsed (text fallback)"));
    }
}

#[test]
fn registration_and_mapping_changes_invalidate_identity() {
    let original = identity(REGISTERED);
    let mut registered = REGISTERED.to_vec();
    // A test-only dialect reuses the Rust grammar to exercise selection without
    // introducing another production language or runtime registry.
    registered.push(Language {
        identity: "test/default/tree-sitter-0.27.0/rust-0.24.2/extractor-1",
        extensions: &["test"],
        ..super::super::rust::LANGUAGE
    });
    assert_ne!(identity(&registered), original);
    assert_ne!(
        select("file.test", &registered).identity,
        for_path("file.test").identity
    );
    let selected = select("file.test", &registered);
    let analysis = (selected.extract)(SourceFile {
        path: "file.test".into(),
        text: "fn named() {}".into(),
    })
    .unwrap();
    assert_eq!(analysis.entities[0].name.as_deref(), Some("named"));
    let registered_identity = identity(&registered);
    registered.last_mut().unwrap().extensions = &["other"];
    assert_ne!(identity(&registered), registered_identity);
    registered.last_mut().unwrap().extensions = &["test"];
    registered.last_mut().unwrap().identity =
        "test/default/tree-sitter-0.27.0/rust-0.24.2/extractor-2";
    assert_ne!(identity(&registered), registered_identity);
    assert_eq!(identity(REGISTERED), original);
}

#[test]
fn the_language_union_is_discoverable_with_explicit_fallback_formats() {
    let reference: serde_json::Value = serde_json::from_str(include_str!(
        "../../benchmarks/versions/port/languages/inputs.json"
    ))
    .unwrap();
    for case in reference.as_array().unwrap() {
        for ext in case["extensions"].as_array().unwrap() {
            let ext = ext.as_str().unwrap();
            assert!(for_path(&format!("file.{ext}")).is_native, "{ext}");
            assert!(default_includes().contains(&format!("**/*.{ext}")));
        }
    }
    for ext in super::super::formats::EXTENSIONS {
        let path = format!("file.{ext}");
        assert!(!for_path(&path).is_native, "{ext}");
        assert!(default_includes().contains(&format!("**/*.{ext}")));
    }
    for path in [
        "Dockerfile",
        "dockerfile.dev",
        "Dockerfile.ts",
        "Jenkinsfile.prod",
        "Gemfile",
        "nested/GNUmakefile",
    ] {
        assert!(!for_path(path).is_native, "{path}");
    }
    assert!(for_path("Gemfile.rb").is_native);
    assert!(for_path("Dockerfiles.ts").is_native);
}

#[test]
fn mdx_headings_preserve_jsx_and_raw_source() {
    let source =
        "# Archive\r\n\r\n<Restore path=\"café\" />\r\n\r\n## Options\r\n\r\nUse the manifest.\r\n";
    let result = super::super::extract(SourceFile {
        path: "guide.mdx".into(),
        text: source.into(),
    })
    .unwrap();
    crate::storage::analysis::validate(&result).unwrap();
    assert!(
        result
            .source_chunks
            .iter()
            .any(|c| c.kind == "section" && c.name.as_deref() == Some("Archive"))
    );
    let previews = crate::retrieval::ts_v2::preview(&result).unwrap();
    assert!(
        previews
            .iter()
            .any(|p| p.text.contains("<Restore path=\"café\" />\r\n"))
    );
    assert!(result.entities.is_empty());
}
