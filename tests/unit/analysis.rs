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

#[test]
fn signatures_keep_written_types_and_modifiers() {
    let a = analyze(
        "pub unsafe extern \"C\" fn f<'a, T: Clone>(x: &'a T) -> Result<T, ()> where T: Send { todo!() }\ntrait X { type Out: Copy; fn f(&mut self); }\nstruct S(pub u8);",
    );
    assert!(a.diagnostics.is_empty());
    let signature = a.facts.iter().find(|f| f.kind == "signature").unwrap();
    let evidence: Vec<_> = signature
        .evidence
        .iter()
        .map(|e| (e.role.as_str(), &a.source.text[e.span.start..e.span.end]))
        .collect();
    for role in [
        "visibility",
        "modifiers",
        "parameter",
        "return_type",
        "generics",
        "lifetime_parameter",
        "bounds",
        "where",
        "type_reference",
    ] {
        assert!(
            evidence.iter().any(|(r, _)| *r == role),
            "{role}: {evidence:?}"
        );
    }
    assert!(evidence.contains(&("modifiers", "unsafe extern \"C\"")));
    assert!(!a.source.text[signature.span.start..signature.span.end].contains("todo"));
    assert!(
        a.facts
            .iter()
            .any(|f| f.evidence.iter().any(|e| e.role == "receiver"))
    );
}

#[test]
fn imports_preserve_groups_and_declaration_references() {
    let a = analyze(
        "pub(crate) use ::std::{self, io::{Read as R, *}, super::thing}; extern crate alloc as a; #[path = \"absent.rs\"] mod absent; mod inline { fn f() { use crate::X; } }",
    );
    assert!(a.diagnostics.is_empty(), "{:?}", a.diagnostics);
    let members: Vec<_> = a
        .facts
        .iter()
        .filter(|f| f.kind == "import_member")
        .collect();
    assert_eq!(members.len(), 5);
    for member in &members {
        assert_eq!(a.facts[member.related.unwrap()].kind, "import");
    }
    let aliased = members
        .iter()
        .find(|f| f.evidence.iter().any(|e| e.role == "alias"))
        .unwrap();
    let prefixes: Vec<_> = aliased
        .evidence
        .iter()
        .filter(|e| e.role == "prefix")
        .map(|e| &a.source.text[e.span.start..e.span.end])
        .collect();
    assert_eq!(prefixes, ["::std", "io"]);
    for kind in ["extern_crate", "module_external", "module_inline"] {
        assert!(a.facts.iter().any(|f| f.kind == kind));
    }
    assert!(members.last().unwrap().owner.is_some());
}

#[test]
fn scopes_and_binding_patterns() {
    let a = analyze(
        "fn f(mut x: u8) { let x = x; let (ref a, mut b) = pair; let c = |z| z; for y in xs { if let Some(k) = y { use crate::X; } else { f(); } } match x { Some(v) | Other(v) => v, _ => 0 } }",
    );
    assert!(a.diagnostics.is_empty(), "{:?}", a.diagnostics);
    let names: Vec<_> = a
        .facts
        .iter()
        .filter(|f| f.kind == "binding")
        .map(|f| &a.source.text[f.span.start..f.span.end])
        .collect();
    assert_eq!(names, ["x", "x", "a", "b", "c", "z", "y", "k", "v", "v"]);
    for (id, scope) in a.scopes.iter().enumerate() {
        if let Some(parent) = scope.parent {
            assert!(parent < id);
        }
    }
    let conditional = a.scopes.iter().find(|s| s.kind == "conditional").unwrap();
    assert!(!a.source.text[conditional.span.start..conditional.span.end].contains("else"));
    assert!(
        a.facts
            .iter()
            .any(|f| f.evidence.iter().any(|e| e.role == "closure_initializer"))
    );
    for fact in &a.facts {
        let scope = &a.scopes[fact.scope];
        assert!(scope.span.start <= fact.span.start && scope.span.end >= fact.span.end);
    }
}

#[test]
fn calls_and_uses_are_written_evidence() {
    let a = analyze(
        "fn f(x: T) { let local = |a| a; local(g()); x.first::<T>().second(h()); Type::new(); <T as Trait>::go(); (factory())(); m!(hidden(call())); let typed: Vec<U> = x as U; }",
    );
    assert!(a.diagnostics.is_empty(), "{:?}", a.diagnostics);
    let calls: Vec<_> = a.facts.iter().filter(|f| f.kind == "call").collect();
    assert_eq!(calls.len(), 9, "{calls:?}");
    assert!(
        !calls
            .iter()
            .any(|f| a.source.text[f.span.start..f.span.end].contains("hidden"))
    );
    for form in ["name_call", "path_call", "method_call", "expression_call"] {
        assert!(
            calls
                .iter()
                .any(|f| f.evidence.iter().any(|e| e.role == form)),
            "{form}"
        );
    }
    assert!(
        calls
            .iter()
            .any(|f| f.evidence.iter().any(|e| e.role == "generics"))
    );
    assert!(a.facts.iter().any(|f| f.kind == "macro_invocation"));
    assert!(
        a.facts
            .iter()
            .any(|f| f.kind == "type_reference" && &a.source.text[f.span.start..f.span.end] == "U")
    );
    assert!(
        !a.facts
            .iter()
            .any(|f| f.kind == "value_reference" && f.span.start < 12)
    );
}

#[test]
fn calls_golden_and_recovery() {
    assert_eq!(
        report(&analyze(include_str!("../fixtures/rust/calls.rs"))),
        include_str!("../goldens/inspect/calls.txt")
    );
    let a = analyze("fn f() { good(); broken( }");
    assert!(!a.diagnostics.is_empty());
    assert!(
        a.facts
            .iter()
            .any(|f| f.kind == "call" && &a.source.text[f.span.start..f.span.end] == "good()")
    );
}

#[test]
fn audit_repository_sources() {
    let mut dirs = vec![std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src")];
    while let Some(dir) = dirs.pop() {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                dirs.push(path);
            } else if path.extension().is_some_and(|e| e == "rs") {
                let a = analyze(&std::fs::read_to_string(&path).unwrap());
                assert!(
                    a.diagnostics.is_empty(),
                    "{}: {:?}",
                    path.display(),
                    a.diagnostics
                );
                crate::storage::analysis::validate(&a)
                    .unwrap_or_else(|e| panic!("{}: {e:#}", path.display()));
            }
        }
    }
}

#[test]
fn tuple_metadata_and_guard_calls_survive_extraction() {
    let a = analyze(
        "struct S(/// docs\n#[cfg(test)] pub u8); fn f() { let S { ref mut field, other: x } = y; match x { Some(v) if pred(v) => f(v), _ => 0 } }",
    );
    let field = a.entities.iter().position(|e| e.kind == "field").unwrap();
    assert!(
        a.facts
            .iter()
            .any(|f| f.kind == "doc" && f.owner == Some(field))
    );
    assert!(
        a.facts
            .iter()
            .any(|f| f.kind == "attribute" && f.owner == Some(field))
    );
    assert!(a.facts.iter().any(|f| f.kind == "signature"
        && f.owner == Some(field)
        && f.evidence.iter().any(|e| e.role == "visibility")));
    assert!(
        a.facts
            .iter()
            .any(|f| f.kind == "binding" && &a.source.text[f.span.start..f.span.end] == "field")
    );
    assert!(
        a.facts
            .iter()
            .any(|f| f.kind == "call" && &a.source.text[f.span.start..f.span.end] == "pred(v)")
    );
    crate::storage::analysis::validate(&a).unwrap();
}

#[test]
fn binding_markers_belong_to_each_pattern_branch() {
    let a = analyze("fn f() { let (ref a, mut b) = pair; }");
    for (name, marker) in [("a", "ref"), ("b", "mut")] {
        let f = a
            .facts
            .iter()
            .find(|f| f.kind == "binding" && &a.source.text[f.span.start..f.span.end] == name)
            .unwrap();
        let markers: Vec<_> = f
            .evidence
            .iter()
            .filter(|e| e.role == "marker")
            .map(|e| &a.source.text[e.span.start..e.span.end])
            .collect();
        assert_eq!(markers, [marker]);
    }
}

#[test]
fn parser_and_computed_spans_agree_on_crlf_and_unicode() {
    for text in [
        " \r\n",
        "\r\n/// café\r\nfn café() { call(); }\r\n",
        "fn f() { let x = 1 }\r\n",
        "mod m { fn f() {} fn f() {} }",
        "\n\n",
    ] {
        let a = analyze(text);
        crate::storage::analysis::validate(&a).unwrap();
        for fact in &a.facts {
            assert_eq!(
                fact.span,
                LineIndex::new(text).span(fact.span.start, fact.span.end)
            );
        }
    }
}

#[test]
fn recovered_prefixes_keep_valid_owned_records() {
    let text = include_str!("../fixtures/rust/declarations.rs");
    for (end, _) in text.char_indices() {
        let a = analyze(&text[..end]);
        crate::storage::analysis::validate(&a).unwrap_or_else(|e| panic!("prefix {end}: {e:#}"));
    }
}

#[test]
fn callable_expression_arguments_and_receivers_remain_references() {
    let a = analyze("fn f() { (factory(arg))(); receiver.method::<Type>(); }");
    for name in ["arg", "receiver", "Type"] {
        assert!(
            a.facts.iter().any(
                |f| matches!(f.kind.as_str(), "value_reference" | "type_reference")
                    && &a.source.text[f.span.start..f.span.end] == name
            ),
            "{name}"
        );
    }
}
