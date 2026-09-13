use super::*;

const FIXTURE: &str = include_str!("../fixtures/go/declarations.go");

fn analyze(source: &str) -> Analysis {
    let analysis = crate::analysis::extract(SourceFile {
        path: "cache.go".into(),
        text: source.into(),
    })
    .unwrap();
    crate::analysis::validation::validate(&analysis).unwrap();
    analysis
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
fn declarations_keep_written_names_groups_and_receivers() {
    let a = analyze(FIXTURE);
    assert!(a.diagnostics.is_empty(), "{:?}", a.diagnostics);
    let names: Vec<_> = a
        .entities
        .iter()
        .filter_map(|e| e.name.as_deref())
        .collect();
    assert_eq!(
        names,
        [
            "Box", "Alias", "Reader", "Labels", "Idle", "Active", "Single", "Factory", "greeting",
            "callback", "Get", "Get", "Identity", "external", "init", "init"
        ]
    );
    assert_eq!(
        a.entities
            .iter()
            .filter(|e| GROUPS.contains(&e.kind.as_str()))
            .count(),
        3
    );
    for entity in &a.entities {
        if let Some(parent) = entity.parent {
            assert!(GROUPS.contains(&a.entities[parent].kind.as_str()));
        }
        if entity.kind == "method" {
            assert!(entity.parent.is_none());
        }
    }
    assert_eq!(a.scopes.len(), 7); // File plus six callables, without group or type scopes.
    let chunks = crate::retrieval::source::chunks(&a).unwrap();
    let owned = |name| {
        let id = a
            .entities
            .iter()
            .position(|e| e.name.as_deref() == Some(name))
            .unwrap();
        chunks.iter().find(|c| c.owner == Some(id)).unwrap()
    };
    assert!(
        owned("Box")
            .text
            .starts_with("// Box keeps a value.\ntype Box")
    );
    assert!(owned("Box").text.contains("json:\"value\""));
    assert!(
        owned("Reader")
            .text
            .starts_with("// Reader consumes a value.")
    );
    assert!(!owned("Reader").text.contains("Shapes are reusable"));
    assert!(owned("Factory").text.contains("type Local int; var local"));
    assert!(
        owned("Get")
            .text
            .starts_with("// Get returns a value.\n// It leaves")
    );
    assert_eq!(owned("Get").context, "cache.go");
    let signature = owned("Get").signature.as_ref().unwrap();
    assert_eq!(
        &FIXTURE[signature.start..signature.end],
        "func (b *Box[T]) Get() (value T)"
    );
    assert_eq!(owned("Active").text, "Active");
    assert!(owned("Single").text.starts_with("const Single int = 1"));
    assert!(
        chunks
            .iter()
            .any(|c| c.owner.is_none() && c.text.contains("import \"C\""))
    );
    coverage(&a);
}

#[test]
fn single_spec_groups_and_multi_name_specs_do_not_duplicate_source() {
    let a = analyze(
        "package p\ntype (Only int)\nconst (\nOne = 1\n)\nvar (\nFirst int\n)\nconst a, b = 1, 2\nvar x, y = 3, 4\nvar _ = f()\n",
    );
    assert!(a.diagnostics.is_empty());
    assert_eq!(a.entities.len(), 9);
    assert_eq!(a.entities.iter().filter(|e| e.name.is_none()).count(), 6);
    for (index, name) in [(1, "Only"), (3, "One"), (5, "First")] {
        assert_eq!(a.entities[index].name.as_deref(), Some(name));
        assert_eq!(a.entities[index].parent, Some(index - 1));
    }
    coverage(&a);
}

#[test]
fn comment_boundaries_preserve_detached_trailing_and_group_comments() {
    let source = "package p\n// detached\n\nfunc a() {} // trailing\nfunc b() {}\n/* attached */\n// more\nfunc c() {}\n// group\nvar (\n  // item\n  x = 1 // x trailing\n  y = 2\n)\n";
    let a = analyze(source);
    let docs: Vec<_> = a
        .facts
        .iter()
        .filter(|f| f.kind == "doc")
        .map(|f| &source[f.span.start..f.span.end])
        .collect();
    assert_eq!(docs, ["/* attached */", "// more", "// group", "// item"]);
    coverage(&a);
}

#[test]
fn recovery_and_all_fixture_prefixes_preserve_valid_source() {
    for source in [FIXTURE.to_owned(), FIXTURE.replace('\n', "\r\n")] {
        for end in source
            .char_indices()
            .map(|(i, _)| i)
            .chain(std::iter::once(source.len()))
        {
            coverage(&analyze(&source[..end]));
        }
    }
    for source in [
        "package p\nfunc (",
        "package p\ntype X struct {",
        "package p\nvar x = func() { var",
        "package p\nconst (One = iota; Two)",
    ] {
        let a = analyze(source);
        assert!(!a.diagnostics.is_empty(), "{source}");
        coverage(&a);
    }
    coverage(&analyze(""));
}

fn check_documents(a: &Analysis, budget: &crate::retrieval::split::TokenBudget) {
    let docs = crate::retrieval::source::documents(a, budget).unwrap();
    assert!(docs.len() > 3);
    let mut end = 0;
    for doc in docs {
        assert!(budget.count(&doc.text).unwrap() <= budget.limit);
        let span = &doc.evidence[0].span;
        assert!(span.start >= end);
        assert!(a.source.text[end..span.start].trim().is_empty());
        assert!(doc.text.ends_with(&a.source.text[span.start..span.end]));
        end = span.end;
        for evidence in doc.evidence.iter().skip(1) {
            let repeated = &a.source.text[evidence.span.start..evidence.span.end];
            assert!(doc.text.contains(repeated));
            assert!(!repeated.contains("café"));
        }
    }
    assert!(a.source.text[end..].trim().is_empty());
}

fn large_source() -> String {
    format!(
        "package p\n// Render a greeting.\nfunc (b *Box[T]) Render() string {{ {} return \"ready\" }}\ntype Huge struct {{ {} }}\nvar messages = []string{{ {} }}\n",
        "println(\"café☕\"); ".repeat(500),
        (0..150)
            .map(|i| format!("Field{i} string; "))
            .collect::<String>(),
        "\"café☕\", ".repeat(500)
    )
}

#[test]
fn oversized_methods_types_and_initializers_repeat_only_headers() {
    let a = analyze(&large_source());
    assert!(a.diagnostics.is_empty());
    let headers: Vec<_> = a
        .facts
        .iter()
        .filter(|f| f.kind == "signature")
        .map(|f| &a.source.text[f.span.start..f.span.end])
        .collect();
    assert_eq!(
        headers,
        [
            "func (b *Box[T]) Render() string",
            "type Huge",
            "var messages ="
        ]
    );
    let budget =
        crate::retrieval::split::TokenBudget::new(crate::test_support::tokenizer(64)).unwrap();
    check_documents(&a, &budget);
    let long = analyze(&format!(
        "package p\nfunc Long[{}]() {{ println(\"café\") }}\n",
        (0..300)
            .map(|i| format!("T{i} any"))
            .collect::<Vec<_>>()
            .join(", ")
    ));
    check_documents(&long, &budget);
}

#[test]
#[ignore = "loads the cached MiniLM tokenizer; run explicitly"]
fn real_model_go_inputs_fit_without_losing_source() {
    let mut embedder = crate::embedding::production().unwrap();
    let budget = embedder.token_budget().unwrap();
    check_documents(&analyze(&large_source()), &budget);
}
