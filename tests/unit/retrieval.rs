use super::*;

fn extract(text: &str) -> Analysis {
    crate::analysis::extract(crate::source::SourceFile {
        path: "fixture.rs".into(),
        text: text.into(),
    })
    .unwrap()
}

#[test]
fn projection_preserves_occurrences_and_unresolved_targets() {
    for text in [
        include_str!("../fixtures/rust/calls.rs"),
        include_str!("../fixtures/rust/declarations.rs"),
        "use a::{b as c, d}; fn f() { let x = a(); { let x = b(); x.go(); } a(); }",
        "fn broken(",
    ] {
        let analysis = extract(text);
        let projection = project(&analysis).unwrap();
        assert!(std::ptr::eq(projection.analysis, &analysis));
        for (id, fact) in analysis.facts.iter().enumerate() {
            let relations: Vec<_> = projection
                .relations
                .iter()
                .filter(|r| r.from == Record::Fact(id))
                .collect();
            assert!(relations.iter().any(|r| r.kind == RelationKind::InScope
                && r.target == Target::Local(Record::Scope(fact.scope))));
            assert_eq!(
                relations
                    .iter()
                    .filter(|r| matches!(r.kind, RelationKind::Component(_)))
                    .count(),
                fact.evidence.len()
            );
            if fact.kind == "call" {
                assert!(
                    relations
                        .iter()
                        .any(|r| r.kind == RelationKind::CallOccurrence
                            && matches!(
                                r.target,
                                Target::Written {
                                    unresolved: true,
                                    ..
                                }
                            ))
                );
            }
        }
    }
}

#[test]
fn projection_rejects_invalid_owners() {
    let mut analysis = extract("fn f() { a(); }");
    analysis.facts[0].owner = Some(999);
    assert!(project(&analysis).is_err());
}
