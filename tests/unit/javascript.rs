use super::*;

fn analyze(path: &str, text: &str) -> Analysis {
    let a = crate::analysis::extract(SourceFile {
        path: path.into(),
        text: text.into(),
    })
    .unwrap();
    crate::analysis::validation::validate(&a).unwrap();
    a
}

fn coverage(a: &Analysis) {
    let mut end = 0;
    let lines = LineIndex::new(&a.source.text);
    for chunk in crate::retrieval::source::chunks(a).unwrap() {
        assert!(chunk.span.start >= end);
        assert!(a.source.text[end..chunk.span.start].trim().is_empty());
        assert_eq!(chunk.text, a.source.text[chunk.span.start..chunk.span.end]);
        assert_eq!(chunk.span, lines.span(chunk.span.start, chunk.span.end));
        end = chunk.span.end;
    }
    assert!(a.source.text[end..].trim().is_empty());
}

#[test]
fn dialects_declarations_and_exact_coverage() {
    for (paths, text) in [
        (
            &["a.ts", "a.mts", "a.cts", "a.d.ts"][..],
            include_str!("../fixtures/javascript/declarations.ts"),
        ),
        (
            &["a.js", "a.mjs", "a.cjs", "a.jsx"][..],
            include_str!("../fixtures/javascript/declarations.js"),
        ),
        (
            &["a.tsx"][..],
            include_str!("../fixtures/javascript/components.tsx"),
        ),
    ] {
        for path in paths {
            let a = analyze(path, text);
            assert!(a.diagnostics.is_empty(), "{path}: {:?}", a.diagnostics);
            assert!(!a.entities.is_empty());
            coverage(&a);
        }
    }
    assert_ne!(
        crate::analysis::language::for_path("a.ts").identity,
        crate::analysis::language::for_path("a.tsx").identity
    );
}

#[test]
fn owners_wrappers_docs_and_initializers_stay_together() {
    let a = analyze(
        "sessions.ts",
        include_str!("../fixtures/javascript/declarations.ts"),
    );
    let names: Vec<_> = a
        .entities
        .iter()
        .filter_map(|e| e.name.as_deref())
        .collect();
    assert_eq!(
        names,
        [
            "Sessions",
            "Entry",
            "Key",
            "Mode",
            "create",
            "Nested",
            "enabled",
            "Store",
            "value",
            "#private",
            "load",
            "load",
            "remove",
            "nested",
            "\"size\"",
            "[Symbol.iterator]",
            "Foreign.Inner",
            "read",
            "overload",
            "walk"
        ]
    );
    let chunks = crate::retrieval::source::chunks(&a).unwrap();
    let owned = |name| {
        let id = a
            .entities
            .iter()
            .position(|e| e.name.as_deref() == Some(name))
            .unwrap();
        chunks.iter().find(|c| c.owner == Some(id)).unwrap()
    };
    assert!(owned("Sessions").text.starts_with("/** Persistent"));
    assert!(
        owned("Store")
            .text
            .starts_with("/** A cache container. */\n  @sealed\n  export abstract class")
    );
    assert!(
        owned("remove")
            .text
            .starts_with("/** Remove expired entries. */\n    @trace\n    async remove")
    );
    assert!(owned("remove").text.contains("function nested()"));
    assert_eq!(
        owned("remove").context,
        "sessions.ts :: namespace Sessions :: class Store"
    );
    assert!(!owned("remove").text.contains("A cache container"));
    assert!(owned("create").text.contains("read() { return value; }"));
    assert!(
        owned("overload")
            .text
            .starts_with("export declare function")
    );
    let header = owned("create").signature.as_ref().unwrap();
    assert_eq!(
        &a.source.text[header.start..header.end],
        "const create = async <T>(value: T): Promise<Entry<T>> =>"
    );
    let multi = chunks
        .iter()
        .find(|c| c.text.starts_with("export const first"))
        .unwrap();
    assert!(a.entities[multi.owner.unwrap()].name.is_none());
    let header = multi.signature.as_ref().unwrap();
    assert_eq!(&a.source.text[header.start..header.end], "const first =");
    assert_eq!(
        chunks
            .iter()
            .filter(|c| c.text.contains("load(key:"))
            .count(),
        2
    );
    coverage(&a);
}

#[test]
fn documentation_boundaries_and_unnamed_exports() {
    let a = analyze(
        "docs.js",
        "/** attached */\nexport function a() {}\n/** detached */\n\nfunction b() {}\n/** stopped */\n// ordinary\nfunction c() {}\nexport default class { run() {} }\nexport default function () {}\nexport default 42;\n",
    );
    assert_eq!(a.facts.iter().filter(|f| f.kind == "doc").count(), 1);
    let unnamed: Vec<_> = a
        .entities
        .iter()
        .filter(|e| e.name.is_none())
        .map(|e| e.kind.as_str())
        .collect();
    assert_eq!(unnamed, ["class", "function", "export"]);
    coverage(&a);
}

#[test]
fn recovery_unicode_and_crlf_keep_source() {
    let text = "/** Żółć */\r\n@sealed\r\nexport class Café {\r\n  @trace\r\n  run(value: string) { return '☕' + value; }\r\n}\r\nexport const [a, b] = pair;\r\n";
    let a = analyze("unicode.ts", text);
    assert!(a.diagnostics.is_empty(), "{:?}", a.diagnostics);
    for end in text
        .char_indices()
        .map(|(i, _)| i)
        .chain(std::iter::once(text.len()))
    {
        coverage(&analyze("unicode.ts", &text[..end]));
    }
    for path in ["broken.ts", "broken.tsx", "broken.js"] {
        for source in [
            "export function broken( {",
            "class {",
            "const [x, =",
            "export const View = () => <div",
            "function f() {\n let x = (\n",
        ] {
            let a = analyze(path, source);
            assert!(!a.diagnostics.is_empty(), "{path}: {source}");
            coverage(&a);
        }
    }
}

#[test]
fn declaration_fixture_prefixes_remain_valid_during_edits() {
    for (path, source) in [
        (
            "editing.ts",
            include_str!("../fixtures/javascript/declarations.ts"),
        ),
        (
            "editing.js",
            include_str!("../fixtures/javascript/declarations.js"),
        ),
        (
            "editing.tsx",
            include_str!("../fixtures/javascript/components.tsx"),
        ),
    ] {
        for end in source
            .char_indices()
            .map(|(i, _)| i)
            .chain(std::iter::once(source.len()))
        {
            coverage(&analyze(path, &source[..end]));
        }
    }
}

#[test]
#[ignore = "loads the cached MiniLM tokenizer; run explicitly"]
fn real_model_javascript_inputs_fit_without_losing_source() {
    let mut embedder = crate::embedding::production().unwrap();
    let budget = embedder.token_budget().unwrap();
    let source = format!(
        "/** Render a status. */\nexport const View = (props: {{ label: string }}) => <section>{}</section>;\n",
        "<span>café☕</span>".repeat(700)
    );
    let a = analyze("large.tsx", &source);
    assert!(a.diagnostics.is_empty());
    let docs = crate::retrieval::source::documents(&a, &budget).unwrap();
    assert!(docs.len() > 3);
    let mut restored = String::new();
    for doc in docs {
        assert!(budget.count(&doc.text).unwrap() <= 512);
        assert_eq!(doc.owner, Some(0));
        let primary = &doc.evidence[0].span;
        restored.push_str(&source[primary.start..primary.end]);
    }
    assert_eq!(restored, source.trim_end_matches('\n'));
}

#[test]
fn oversized_components_preserve_bytes_and_repeat_only_headers() {
    let text = format!(
        "/** A long component. */\nexport const View = (props: {{label: string}}) => <section>{}</section>;\n",
        "<span>café☕</span>\n".repeat(150)
    );
    let a = analyze("large.tsx", &text);
    assert!(a.diagnostics.is_empty());
    let budget =
        crate::retrieval::split::TokenBudget::new(crate::test_support::tokenizer(64)).unwrap();
    let docs = crate::retrieval::source::documents(&a, &budget).unwrap();
    assert!(docs.len() > 3);
    let mut restored = String::new();
    for doc in &docs {
        assert_eq!(doc.owner, Some(0));
        assert!(budget.count(&doc.text).unwrap() <= budget.limit);
        let primary = &doc.evidence[0].span;
        restored.push_str(&text[primary.start..primary.end]);
        assert!(doc.text.ends_with(&text[primary.start..primary.end]));
        let signature = &doc.evidence[1].span;
        assert!(!text[signature.start..signature.end].contains("<section>"));
    }
    assert_eq!(restored, text.trim_end_matches('\n'));
}
