use super::*;

#[test]
fn grammar_loads_for_python_and_stubs() {
    for path in ["a.py", "a.pyi"] {
        let analysis = crate::analysis::extract(SourceFile {
            path: path.into(),
            text: "def café[T](value: T) -> T:\n    return value\n".into(),
        })
        .unwrap();
        assert!(
            analysis.diagnostics.is_empty(),
            "{:?}",
            analysis.diagnostics
        );
        assert_eq!(analysis.entities[0].name.as_deref(), Some("café"));
        crate::analysis::validation::validate(&analysis).unwrap();
    }
}

fn analyze(path: &str, text: &str) -> Analysis {
    let analysis = crate::analysis::extract(SourceFile {
        path: path.into(),
        text: text.into(),
    })
    .unwrap();
    crate::analysis::validation::validate(&analysis).unwrap();
    analysis
}

fn assert_coverage(analysis: &Analysis) {
    let chunks = crate::retrieval::source::chunks(analysis).unwrap();
    let mut position = 0;
    let lines = LineIndex::new(&analysis.source.text);
    for chunk in &chunks {
        assert!(chunk.span.start >= position);
        assert!(
            analysis.source.text[position..chunk.span.start]
                .trim()
                .is_empty()
        );
        assert_eq!(
            chunk.text,
            analysis.source.text[chunk.span.start..chunk.span.end]
        );
        assert_eq!(chunk.span, lines.span(chunk.span.start, chunk.span.end));
        position = chunk.span.end;
    }
    assert!(analysis.source.text[position..].trim().is_empty());
}

#[test]
fn declarations_decorators_scopes_and_nested_owners() {
    let text = include_str!("../fixtures/python/declarations.py");
    let a = analyze("service.py", text);
    assert!(a.diagnostics.is_empty(), "{:?}", a.diagnostics);
    let declarations: Vec<_> = a
        .entities
        .iter()
        .map(|e| (e.kind.as_str(), e.name.as_deref().unwrap(), e.parent))
        .collect();
    assert_eq!(
        declarations,
        [
            ("class", "Service", None),
            ("method", "create", Some(0)),
            ("function", "nested", Some(1)),
            ("method", "name", Some(0)),
            ("class", "Options", Some(0)),
            ("method", "reset", Some(4)),
            ("method", "optional", Some(0)),
            ("function", "session", None),
            ("class", "Local", Some(7)),
            ("method", "local_method", Some(8)),
            ("function", "conditional", None),
        ]
    );
    assert!(
        a.facts
            .iter()
            .all(|f| matches!(f.kind.as_str(), "doc" | "decorator" | "signature"))
    );
    assert_eq!(a.scopes.len(), a.entities.len() + 1);
    assert!(a.facts.iter().any(|f| f.kind == "doc" && f.owner.is_none()));
    let decorator = a
        .facts
        .iter()
        .find(|f| f.kind == "decorator" && f.owner == Some(1))
        .unwrap();
    assert_eq!(
        &text[decorator.span.start..decorator.span.end],
        "@classmethod"
    );
    assert_eq!(a.scopes[decorator.scope].owner, Some(0));
    let header = a
        .facts
        .iter()
        .find(|f| f.kind == "signature" && f.owner == Some(1))
        .unwrap();
    assert_eq!(
        &text[header.span.start..header.span.end],
        "async def create(\n        cls,\n        source: str,\n        *,\n        transform=lambda value: value,\n    ) -> \"Service[T]\":"
    );
    let chunks = crate::retrieval::source::chunks(&a).unwrap();
    let method = chunks.iter().find(|c| c.owner == Some(1)).unwrap();
    assert!(
        method
            .text
            .starts_with("@classmethod\n    async def create(")
    );
    assert!(
        method
            .text
            .contains("Create a service from a named source.")
    );
    assert!(method.text.contains("async def nested(value):"));
    assert_eq!(method.context, "service.py :: class Service");
    assert!(
        !chunks
            .iter()
            .any(|c| c.owner == Some(2) || c.owner == Some(8) || c.owner == Some(9))
    );
    assert!(!method.text.contains("Keep service state"));
    assert_coverage(&a);
}

#[test]
fn stubs_keep_overloads_and_decorators_as_distinct_owners() {
    let a = analyze("api.pyi", include_str!("../fixtures/python/overloads.pyi"));
    assert!(a.diagnostics.is_empty());
    let chunks = crate::retrieval::source::chunks(&a).unwrap();
    let overloads: Vec<_> = chunks
        .iter()
        .filter(|c| c.text.starts_with("@overload"))
        .collect();
    assert_eq!(overloads.len(), 4);
    let owners: std::collections::HashSet<_> = overloads.iter().map(|c| c.owner).collect();
    assert_eq!(owners.len(), 4);
    assert!(overloads.iter().all(|c| c.text.ends_with("...")));
    assert_coverage(&a);
}

#[test]
fn docstrings_are_only_leading_plain_string_expressions() {
    for (body, expected) in [
        ("# comment\n\"\"\"docs\"\"\"\n", 1),
        ("r\"docs\"\n", 1),
        ("u\"docs\"\n", 1),
        ("(\"first\" \"second\")\n", 1),
        ("b\"bytes\"\n", 0),
        ("f\"formatted {name}\"\n", 0),
        ("\"first\" f\"{name}\"\n", 0),
        ("value = 1\n\"later string\"\n", 0),
        ("\"first\"\n\"later string\"\n", 1),
    ] {
        let a = analyze("docs.py", body);
        assert_eq!(
            a.facts.iter().filter(|f| f.kind == "doc").count(),
            expected,
            "{body}"
        );
        assert_coverage(&a);
    }
}

#[test]
fn recovered_prefixes_and_unicode_keep_valid_exact_coverage() {
    let text = "@decorate(\"café\")\r\nclass Café:\r\n    @property\r\n    def value(self) -> str:\r\n        \"\"\"Żółć.\"\"\"\r\n        return \"☕\"\r\n\r\ndef other(): pass\r\n";
    let a = analyze("unicode.py", text);
    assert!(a.diagnostics.is_empty());
    assert_coverage(&a);
    for end in text
        .char_indices()
        .map(|(i, _)| i)
        .chain(std::iter::once(text.len()))
    {
        assert_coverage(&analyze("unicode.py", &text[..end]));
    }
    for malformed in [
        "def broken(:\n    pass\n",
        "class :\n pass",
        "@\n",
        "def f()\n    pass\n",
        "def f():\n    x = (1\n",
    ] {
        let a = analyze("broken.py", malformed);
        assert!(!a.diagnostics.is_empty(), "{malformed}");
        assert_coverage(&a);
    }
}

#[test]
fn oversized_python_inputs_repeat_headers_without_losing_source() {
    let text = format!(
        "@decorate\nasync def process(value: str) -> str:\n    \"\"\"Process a label.\"\"\"\n    label = \"{}\"\n{}    return label\n",
        "café☕".repeat(150),
        "    value = value.strip()\n".repeat(120)
    );
    let a = analyze("large.py", &text);
    let budget =
        crate::retrieval::split::TokenBudget::new(crate::test_support::tokenizer(64)).unwrap();
    let docs = crate::retrieval::source::documents(&a, &budget).unwrap();
    assert!(docs.len() > 2);
    let mut restored = String::new();
    for doc in &docs {
        assert!(budget.count(&doc.text).unwrap() <= budget.limit);
        assert_eq!(doc.owner, Some(0));
        assert_eq!(doc.evidence.len(), 2);
        let source = &doc.evidence[0].span;
        restored.push_str(&text[source.start..source.end]);
        let header = &doc.evidence[1].span;
        assert!(text[header.start..header.end].starts_with("async def"));
        assert!(doc.text.ends_with(&text[source.start..source.end]));
    }
    assert_eq!(restored, text.trim_end_matches('\n'));
}
