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

#[test]
fn descriptions_match_query_evidence_without_inferred_behavior() {
    let analysis = extract(include_str!("../fixtures/retrieval/sessions.rs"));
    let projection = project(&analysis).unwrap();
    let documents = render::render(&projection);
    assert_eq!(documents, render::render(&projection));
    let cases: serde_json::Value =
        serde_json::from_str(include_str!("../fixtures/retrieval/queries.json")).unwrap();
    for case in cases.as_array().unwrap() {
        let owner = analysis
            .entities
            .iter()
            .position(|e| e.name.as_deref() == case["entity"].as_str())
            .unwrap();
        let document = documents.iter().find(|d| d.owner == Some(owner)).unwrap();
        assert!(
            document
                .facts
                .iter()
                .any(|c| c.text == case["document_clause"].as_str().unwrap())
        );
        for clause in &document.facts {
            assert!(!clause.evidence.is_empty());
        }
    }
    assert!(render::render(&project(&extract(" \n")).unwrap()).is_empty());
    let text = serde_json::to_string(&documents).unwrap();
    assert!(!text.contains("session.expires > now"));
    assert!(!text.contains("resolves to"));
}

#[test]
fn split_preserves_oversized_unicode_clauses_and_special_token_budget() {
    let budget = split::TokenBudget::new(crate::test_support::tokenizer(32)).unwrap();
    assert_eq!(budget.count("hello").unwrap(), 3);
    let analysis = extract("/// docs\nfn f() {}");
    let mut descriptions = render::render(&project(&analysis).unwrap());
    let content = "Café 東京 x ".repeat(300);
    descriptions[0].facts.truncate(1);
    descriptions[0].facts[0].text = content.clone();
    let parts = budget.split(&descriptions).unwrap();
    assert!(parts.len() > 1);
    assert_eq!(parts, budget.split(&descriptions).unwrap());
    let prefix = format!("{}\n", descriptions[0].identity.text);
    let recovered: String = parts
        .iter()
        .map(|p| p.text.strip_prefix(&prefix).unwrap())
        .collect();
    assert_eq!(recovered, content);
    for (id, part) in parts.iter().enumerate() {
        assert_eq!(part.part, id);
        assert!(budget.count(&part.text).unwrap() <= 32);
        assert!(
            part.evidence
                .contains(&descriptions[0].facts[0].evidence[0])
        );
    }
    descriptions[0].identity.text = "long identifier ".repeat(200);
    assert!(
        budget
            .split(&descriptions)
            .unwrap()
            .iter()
            .all(|d| budget.count(&d.text).unwrap() <= 32)
    );
}

#[test]
fn complete_inputs_fit_exactly_at_the_limit_then_split_one_token_over() {
    let budget = split::TokenBudget::new(crate::test_support::tokenizer(32)).unwrap();
    let analysis = extract("/// text\nfn f() {}");
    let mut descriptions = render::render(&project(&analysis).unwrap());
    let d = &mut descriptions[0];
    d.facts.truncate(1);
    let mut words = String::new();
    while budget
        .count(&format!("{}\n{}x", d.identity.text, words))
        .unwrap()
        <= 32
    {
        words.push_str("x ");
    }
    d.facts[0].text = words.clone();
    let parts = budget.split(&descriptions).unwrap();
    assert_eq!(parts.len(), 1);
    assert_eq!(budget.count(&parts[0].text).unwrap(), 32);
    descriptions[0].facts[0].text.push('x');
    assert_eq!(budget.split(&descriptions).unwrap().len(), 2);
}

#[test]
#[ignore = "loads the cached model or downloads it; run explicitly"]
fn real_model_documents_never_rely_on_backend_truncation() {
    let mut embedder = crate::embedding::production().unwrap();
    let budget = embedder.token_budget().unwrap();
    assert_eq!(budget.limit, 512);
    assert_eq!(budget.count("hello").unwrap(), 3);
    let source = format!(
        "/// {}\nfn very_long_name() {{ helper(); }}",
        "Café 東京 identifiers ".repeat(800)
    );
    let descriptions = render::render(&project(&extract(&source)).unwrap());
    let parts = budget.split(&descriptions).unwrap();
    assert!(parts.len() > 2);
    assert!(parts.iter().all(|p| budget.count(&p.text).unwrap() <= 512));
    let texts: Vec<_> = parts.into_iter().map(|p| p.text).collect();
    assert_eq!(
        embedder
            .embed_documents(&texts, |_, _| Ok(()))
            .unwrap()
            .len(),
        texts.len()
    );
}

#[test]
fn descriptions_match_readable_golden() {
    let analysis = extract(include_str!("../fixtures/retrieval/sessions.rs"));
    let descriptions = render::render(&project(&analysis).unwrap());
    let text = descriptions
        .iter()
        .map(|d| {
            std::iter::once(d.identity.text.as_str())
                .chain(d.facts.iter().map(|c| c.text.as_str()))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .collect::<Vec<_>>()
        .join("\n\n")
        + "\n";
    assert_eq!(text, include_str!("../fixtures/retrieval/descriptions.txt"));
}
