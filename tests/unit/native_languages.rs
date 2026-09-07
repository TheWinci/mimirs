use super::*;
use serde_json::{Value, json};

fn fixture_cases() -> Vec<Value> {
    let reference: Value = serde_json::from_str(include_str!(
        "../../benchmarks/versions/port/languages/reference.json"
    ))
    .unwrap();
    reference["cases"].as_array().unwrap().clone()
}

fn analyze(path: &str, source: &str) -> Analysis {
    let result = crate::analysis::extract(SourceFile {
        path: path.into(),
        text: source.into(),
    })
    .unwrap();
    crate::storage::analysis::validate(&result).unwrap();
    let mut covered = vec![false; source.len()];
    for document in ts_v2::documents(&result).unwrap() {
        for evidence in document.evidence {
            let span = evidence.span;
            assert!(source.get(span.start..span.end).is_some());
            covered[span.start..span.end].fill(true);
        }
    }
    for (i, c) in source.char_indices() {
        assert!(
            c.is_whitespace() || (i == 0 && c == '\u{feff}') || covered[i],
            "uncovered {path} byte {i}"
        );
    }
    result
}

#[test]
fn native_languages_match_pinned_ts_chunks() {
    for case in fixture_cases() {
        let path = case["path"].as_str().unwrap();
        if !crate::analysis::language::for_path(path).is_native {
            continue;
        }
        let source = case["source"].as_str().unwrap();
        let result = analyze(path, source);
        assert!(
            result.diagnostics.is_empty(),
            "{path}: {:?}",
            result.diagnostics
        );
        let chunks: Vec<_> = result
            .source_chunks
            .iter()
            .map(|chunk| {
                json!({
                    "kind": chunk.kind, "name": chunk.name, "parent": chunk.parent,
                    "start": chunk.span.start, "end": chunk.span.end,
                })
            })
            .collect();
        assert_eq!(json!(chunks), case["chunks"], "{path}");
        assert!(!result.entities.is_empty(), "{path}");
        assert!(result.facts.iter().any(|f| f.kind == "signature"), "{path}");
        let raw = format!("\u{feff}{}", source.replace('\n', "\r\n"));
        let normalized = analyze(path, &raw);
        assert_eq!(
            normalized
                .entities
                .iter()
                .map(|e| (&e.kind, &e.name))
                .collect::<Vec<_>>(),
            result
                .entities
                .iter()
                .map(|e| (&e.kind, &e.name))
                .collect::<Vec<_>>()
        );
        // Recovery must retain the whole partial source and valid source spans.
        let mut end = source.len() / 2;
        while !source.is_char_boundary(end) {
            end -= 1;
        }
        analyze(path, &source[..end]);
        analyze(path, &source.repeat(80));
    }
}

#[test]
fn java_owners_signatures_docs_and_recovery_are_source_backed() {
    let result = analyze(
        "Store.java",
        "/** Recover archives. */\nclass Store {\n  String recover(String path) { return path; }\n  class Nested { void recover() {} }\n}\n",
    );
    let methods: Vec<_> = result
        .entities
        .iter()
        .filter(|e| e.name.as_deref() == Some("recover"))
        .collect();
    assert_eq!(methods.len(), 2);
    assert_ne!(methods[0].parent, methods[1].parent);
    let doc = result.facts.iter().find(|f| f.kind == "doc").unwrap();
    assert_eq!(
        &result.source.text[doc.span.start..doc.span.end],
        "/** Recover archives. */"
    );
    let signature = result
        .facts
        .iter()
        .find(|f| f.kind == "signature" && f.owner == Some(1))
        .unwrap();
    assert_eq!(
        &result.source.text[signature.span.start..signature.span.end],
        "String recover(String path)"
    );
    assert!(
        !analyze("Broken.java", "class Store { void recover( {")
            .diagnostics
            .is_empty()
    );
}

#[test]
fn c_names_follow_declarators_without_confusing_function_pointers() {
    let result = analyze(
        "bindings.h",
        "#ifndef ARCHIVE_H\n#define ARCHIVE_H\ntypedef int (*Callback)(int);\nint recover(int count);\nint (*callback)(int);\nconst int first = 1, second = 2;\nstruct Archive { int count, size; };\n#endif\n",
    );
    for (name, kind) in [
        ("!defined(ARCHIVE_H)", "conditional"),
        ("Callback", "type"),
        ("recover", "function"),
        ("callback", "variable"),
        ("first, second", "constant"),
        ("count, size", "field"),
    ] {
        assert!(
            result
                .entities
                .iter()
                .any(|e| e.name.as_deref() == Some(name) && e.kind == kind),
            "{name}: {:?}",
            result.entities
        );
    }
}

#[test]
fn cpp_templates_qualified_methods_and_header_aliases_keep_names() {
    let source = "template <class T> class Store { public: T recover(T value); };\ntemplate <class T> T Store<T>::recover(T value) { return value; }\nclass Other { public: int count; int recover(); };\nint Other::recover() { return 1; }\nint (*callback)(int);\n";
    for ext in ["cpp", "cc", "cxx", "hpp", "hh", "hxx"] {
        let result = analyze(&format!("store.{ext}"), source);
        assert!(
            result
                .entities
                .iter()
                .any(|e| e.name.as_deref() == Some("Store") && e.kind == "class")
        );
        assert!(
            result
                .entities
                .iter()
                .any(|e| e.name.as_deref() == Some("Other::recover") && e.kind == "method")
        );
        assert!(
            result
                .entities
                .iter()
                .any(|e| e.name.as_deref() == Some("callback") && e.kind == "variable")
        );
        assert_eq!(
            result
                .entities
                .iter()
                .filter(|e| e.name.as_deref() == Some("Store"))
                .count(),
            1
        );
    }
}

#[test]
fn csharp_file_namespace_operators_and_fields_retain_their_owners() {
    let result = analyze(
        "Store.cs",
        "namespace Archive;\nclass Store {\n int count, size;\n public int this[int index] => index;\n public static Store operator +(Store a, Store b) => a;\n public static implicit operator int(Store a) => 1;\n void Recover() { System.Func<int,int> callback = x => x; }\n}\n",
    );
    assert_eq!(result.entities[0].span.end, result.source.text.len());
    for (name, kind) in [
        ("count, size", "field"),
        ("this", "property"),
        ("operator +", "method"),
        ("implicit operator int", "method"),
        ("callback", "function"),
    ] {
        assert!(
            result
                .entities
                .iter()
                .any(|e| e.name.as_deref() == Some(name) && e.kind == kind),
            "{name}: {:?}",
            result.entities
        );
    }
}

#[test]
fn ruby_singleton_classes_constants_and_lambdas_have_distinct_kinds() {
    let result = analyze(
        "store.rb",
        "LIMIT = 4\ncallback = ->(path) { path }\nclass Store\n  class << self\n    def recover(path)\n      path\n    end\n  end\nend\n",
    );
    for (name, kind) in [
        ("LIMIT", "constant"),
        ("callback", "function"),
        ("singleton self", "class"),
        ("recover", "method"),
    ] {
        assert!(
            result
                .entities
                .iter()
                .any(|e| e.name.as_deref() == Some(name) && e.kind == kind),
            "{name}: {:?}",
            result.entities
        );
    }
}

#[test]
fn native_snapshots_round_trip_replace_rollback_and_delete() {
    for case in fixture_cases() {
        let path = case["path"].as_str().unwrap();
        if !crate::analysis::language::for_path(path).is_native {
            continue;
        }
        let dir = tempfile::tempdir().unwrap();
        let mut connection = crate::storage::open(&dir.path().join("index.db"))
            .unwrap()
            .connection;
        connection
            .execute("INSERT INTO files VALUES (1, ?1)", [path])
            .unwrap();
        let original = analyze(path, case["source"].as_str().unwrap());
        let tx = connection.transaction().unwrap();
        crate::storage::analysis::write(&tx, 1, &original).unwrap();
        tx.commit().unwrap();
        let loaded = crate::storage::analysis::load(&connection, path)
            .unwrap()
            .unwrap();
        assert_eq!(original, loaded);
        assert_eq!(
            serde_json::to_value(ts_v2::preview(&original).unwrap()).unwrap(),
            serde_json::to_value(ts_v2::preview(&loaded).unwrap()).unwrap()
        );
        let empty = analyze(path, "");
        {
            let tx = connection.transaction().unwrap();
            crate::storage::analysis::write(&tx, 1, &empty).unwrap();
        }
        assert_eq!(
            crate::storage::analysis::load(&connection, path)
                .unwrap()
                .unwrap(),
            original
        );
        let tx = connection.transaction().unwrap();
        crate::storage::analysis::write(&tx, 1, &empty).unwrap();
        tx.commit().unwrap();
        assert_eq!(
            crate::storage::analysis::load(&connection, path)
                .unwrap()
                .unwrap(),
            empty
        );
        connection.execute("DELETE FROM files", []).unwrap();
        assert!(
            crate::storage::analysis::load(&connection, path)
                .unwrap()
                .is_none()
        );
    }
}
