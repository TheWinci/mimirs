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
