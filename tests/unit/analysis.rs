use super::*;

fn analyze(text: &str) -> Analysis {
    extract(SourceFile {
        path: "fixture.rs".into(),
        text: text.into(),
    })
    .unwrap()
}

#[test]
fn snapshots_and_diagnostics() {
    for text in ["", "fn café() {}\r\n", "fn f() { let x = 1 }", "fn ("] {
        let analysis = analyze(text);
        assert_eq!(analysis.source.text, text);
        assert_eq!(report(&analysis), report(&analyze(text)));
        for d in &analysis.diagnostics {
            assert!(text.get(d.span.start..d.span.end).is_some());
        }
    }
    assert!(analyze("").diagnostics.is_empty());
    assert!(analyze("fn café() {}\r\n").diagnostics.is_empty());
    assert!(
        analyze("fn f() { let x = 1 }")
            .diagnostics
            .iter()
            .any(|d| d.kind == "missing ;" && d.span.start == d.span.end)
    );
}

#[test]
fn diagnostic_goldens() {
    for (source, golden) in [
        ("", include_str!("../goldens/inspect/empty.txt")),
        ("fn f() {}", include_str!("../goldens/inspect/valid.txt")),
        (
            "fn f() { let x = 1 }",
            include_str!("../goldens/inspect/missing.txt"),
        ),
    ] {
        assert_eq!(report(&analyze(source)), golden);
    }
}

#[test]
fn declarations_retain_exact_evidence_and_order() {
    let text = include_str!("../fixtures/rust/declarations.rs");
    let a = analyze(text);
    assert!(a.diagnostics.is_empty(), "{:?}", a.diagnostics);
    for kind in [
        "module", "struct", "field", "union", "enum", "variant", "trait", "impl", "type", "const",
        "static", "macro", "function",
    ] {
        assert!(a.entities.iter().any(|e| e.kind == kind), "{kind}");
    }
    assert!(
        a.entities
            .windows(2)
            .all(|es| es[0].span.start <= es[1].span.start)
    );
    assert_eq!(
        a.entities
            .iter()
            .filter(|e| e.name.as_deref() == Some("same"))
            .count(),
        2
    );
    assert!(
        !a.entities
            .iter()
            .any(|e| e.name.as_deref() == Some("hidden"))
    );
    assert!(
        a.entities
            .iter()
            .any(|e| e.name.as_deref() == Some("Work for Café"))
    );
    assert_eq!(
        a.entities
            .iter()
            .filter(|e| e.kind == "field" && e.name.is_none())
            .count(),
        3
    );
    for e in a.entities {
        assert!(!text[e.span.start..e.span.end].is_empty());
    }
}

#[test]
fn lexical_parents_and_methods() {
    let a = analyze(include_str!("../fixtures/rust/declarations.rs"));
    for (id, e) in a.entities.iter().enumerate() {
        if let Some(parent) = e.parent {
            assert!(parent < id);
            let p = &a.entities[parent];
            assert!(p.span.start <= e.span.start && p.span.end >= e.span.end);
        }
    }
    let inner = a
        .entities
        .iter()
        .find(|e| e.name.as_deref() == Some("inner"))
        .unwrap();
    assert_eq!(inner.kind, "function");
    assert_eq!(a.entities[inner.parent.unwrap()].kind, "method");
    assert_eq!(a.entities.iter().filter(|e| e.kind == "method").count(), 2);
    let a = analyze("mod m { struct X {} struct X {} fn broken(");
    assert_eq!(
        a.entities
            .iter()
            .filter(|e| e.name.as_deref() == Some("X"))
            .count(),
        2
    );
}

#[test]
fn explicit_documentation_ownership() {
    let a = analyze(
        "//! file\n// section\n/// docs\n#[cfg(test)]\n// gap\n\nfn f() { /* body /* nested */ */ } // trailing\n",
    );
    let f = a
        .entities
        .iter()
        .position(|e| e.name.as_deref() == Some("f"))
        .unwrap();
    let text = |fact: &Fact| &a.source.text[fact.span.start..fact.span.end];
    assert_eq!(
        a.facts
            .iter()
            .find(|x| text(x).starts_with("///"))
            .unwrap()
            .owner,
        Some(f)
    );
    assert_eq!(
        a.facts
            .iter()
            .find(|x| x.kind == "attribute")
            .unwrap()
            .owner,
        Some(f)
    );
    for prefix in ["//!", "// section", "// gap", "// trailing"] {
        assert_eq!(
            a.facts
                .iter()
                .find(|x| text(x).starts_with(prefix))
                .unwrap()
                .owner,
            None
        );
    }
    assert_eq!(
        a.facts
            .iter()
            .find(|x| text(x).starts_with("/*"))
            .unwrap()
            .owner,
        Some(f)
    );
    let attr = a.facts.iter().find(|x| x.kind == "attribute").unwrap();
    assert_eq!(
        &a.source.text[attr.evidence[0].span.start..attr.evidence[0].span.end],
        "cfg"
    );
    assert_eq!(attr.evidence[1].role, "arguments");
}

#[test]
fn comments_golden() {
    assert_eq!(
        report(&analyze(include_str!("../fixtures/rust/comments.rs"))),
        include_str!("../goldens/inspect/comments.txt")
    );
}
