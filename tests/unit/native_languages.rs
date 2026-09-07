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
fn php_namespaces_end_before_the_next_namespace_and_strip_property_sigils() {
    let source = "<?php\nnamespace First;\nclass Store { public $count, $size; public function __construct(public int $limit) {} }\n$recover = fn($path) => $path;\nnamespace Second;\nclass Store {}\n";
    let result = analyze("store.php", source);
    assert_eq!(
        result.entities[0].span.end,
        source.find("namespace Second").unwrap()
    );
    for (name, kind) in [
        ("count, size", "field"),
        ("limit", "field"),
        ("recover", "function"),
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
    let stores: Vec<_> = result
        .entities
        .iter()
        .filter(|e| e.name.as_deref() == Some("Store"))
        .collect();
    assert_eq!(stores.len(), 2);
    assert_ne!(stores[0].parent, stores[1].parent);
}

#[test]
fn scala_constructor_parameters_and_methods_have_honest_owners() {
    let result = analyze(
        "Store.scala",
        "package archive\nclass Store(hidden: Int, val count: Int) { def recover(path: String): String = path }\ncase class Entry(value: Int)\n",
    );
    assert!(
        !result
            .entities
            .iter()
            .any(|e| e.name.as_deref() == Some("hidden"))
    );
    for (name, kind) in [
        ("count", "field"),
        ("value", "field"),
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
fn html_void_tags_do_not_swallow_the_following_elements() {
    let result = analyze(
        "page.htm",
        "<main><input type=\"text\"><p>Recover archives</p><script>function recover() {}</script></main>\n",
    );
    let input = result
        .entities
        .iter()
        .find(|e| e.name.as_deref() == Some("input"))
        .unwrap();
    assert_eq!(
        &result.source.text[input.span.start..input.span.end],
        "<input type=\"text\">"
    );
    assert!(
        result
            .entities
            .iter()
            .any(|e| e.name.as_deref() == Some("p") && e.parent == Some(0))
    );
    assert!(result.source.text.contains("function recover()"));
}

#[test]
fn css_at_rule_names_include_conditions_and_nested_selectors() {
    let result = analyze(
        "store.css",
        "@supports (display: grid) { .archive { display: grid; } }\n@layer archives;\n@keyframes recover { from { opacity: 0; } to { opacity: 1; } }\n",
    );
    for (name, kind) in [
        ("@supports (display: grid)", "rule"),
        (".archive", "selector"),
        ("@layer archives", "rule"),
        ("recover", "rule"),
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
fn kotlin_distinguishes_class_kinds_parameters_and_companions() {
    let result = analyze(
        "Store.kts",
        "package archive\ndata class Entry(val count: Int)\nclass Store(hidden: Int, val count: Int) {\n companion object {\n  fun recover(): Int { return 1 }\n }\n val size = 4\n}\ninterface Reader {\n fun read(): Int\n}\n",
    );
    assert!(
        !result
            .entities
            .iter()
            .any(|e| e.name.as_deref() == Some("hidden"))
    );
    for (name, kind) in [
        ("Entry", "record"),
        ("count", "field"),
        ("size", "field"),
        ("(companion)", "class"),
        ("recover", "method"),
        ("Reader", "interface"),
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
fn lua_assignments_methods_and_function_fields_keep_written_names() {
    let result = analyze(
        "store.lua",
        "local count, size = 1, 2\nlocal recover = function(path) return path end\nlocal store = { restore = function(path) return path end }\nfunction store:read(path) return path end\n",
    );
    for (name, kind) in [
        ("count, size", "variable"),
        ("recover", "function"),
        ("restore", "function"),
        ("store:read", "method"),
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
fn zig_containers_tests_and_errors_keep_distinct_names() {
    let result = analyze(
        "store.zig",
        "const State = enum { ready, failed };\nconst Errors = error { Missing, Corrupt };\nconst Store = struct { count: usize, fn recover() void {} };\ntest \"recover archive\" {}\ncomptime {}\n",
    );
    for (name, kind) in [
        ("State", "enum"),
        ("ready", "constant"),
        ("Errors", "type"),
        ("Missing", "constant"),
        ("Store", "struct"),
        ("recover", "method"),
        ("recover archive", "function"),
        ("comptime", "initializer"),
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
fn elixir_definition_keywords_distinguish_protocols_structs_and_implementations() {
    let result = analyze(
        "store.exs",
        "defprotocol Recover do\n def recover(path)\nend\ndefmodule Archive.Store do\n defstruct [:count]\n @callback restore(String.t()) :: String.t()\nend\ndefimpl Recover, for: Archive.Store do\n def recover(path), do: path\nend\n",
    );
    for (name, kind) in [
        ("Recover", "trait"),
        ("Store", "struct"),
        ("restore", "method"),
        ("Recover for Archive.Store", "impl"),
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
