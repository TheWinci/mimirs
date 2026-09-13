use super::*;
use crate::context::test_support::*;
use std::fs;

fn query(f: &Fixture, query: &str, hints: &[&str], limit: usize) -> (Selection, Vec<String>) {
    let mut reads = Vec::new();
    let checkout = f.checkout();
    let result = select(
        &checkout,
        &f.events(),
        query,
        &hints.iter().map(|s| (*s).into()).collect(),
        limit,
        |path| {
            reads.push(path.to_owned());
            checkout.read(path)
        },
    )
    .unwrap();
    (result, reads)
}

#[test]
fn weighted_tokens_scope_path_only_and_stable_ties() {
    let mut f = Fixture::new();
    let a = f.learn("Retains octets", None, &["reader.rs"]);
    let b = f.learn("Reader byte spans", Some("original offset"), &["reader.rs"]);
    let c = f.learn("Reader byte spans", Some("original offset"), &["reader.rs"]);
    let (selected, reads) = query(&f, "reader reader original", &[], 5);
    assert_eq!(reads, ["reader.rs"]);
    assert_eq!(selected.items[0]["id"], json!(b));
    assert_eq!(selected.items[1]["id"], json!(c));
    assert_eq!(selected.items[0]["selection"]["score"], 7); // statement4+rationale2+scope1
    assert_eq!(selected.items[2]["id"], json!(a)); // scope alone
    let (only_path, _) = query(&f, "utterly different wording", &["reader.rs"], 5);
    assert_eq!(only_path.items[0]["id"], json!(a));
    assert_eq!(only_path.items[0]["selection"]["lexical_score"], 0);
    assert_eq!(only_path.items[0]["selection"]["score"], 3);
    assert_eq!(
        only_path.items[0]["selection"]["source_paths"],
        json!(["reader.rs"])
    );
}

#[test]
fn selection_precedes_bounded_shared_evidence_and_empty_differs_from_no_match() {
    let mut f = Fixture::new();
    assert_eq!(query(&f, "reader", &[], 5).0.summary["status"], "empty");
    for n in 0..12 {
        f.learn(&format!("reader contract {n}"), None, &["reader.rs"]);
    }
    f.learn("database retry contract", None, &["retry.rs"]);
    let before = f.journal();
    let (result, reads) = query(&f, "reader", &[], 3);
    assert_eq!(result.items.len(), 3);
    assert_eq!(result.summary["omitted_candidates"], 9);
    assert_eq!(result.summary["ancestry_checks"], 1);
    assert_eq!(reads, ["reader.rs"]);
    let (none, reads) = query(&f, "unmatched", &[], 5);
    assert_eq!(none.summary["status"], "no_match");
    assert!(reads.is_empty());
    assert_eq!(f.journal(), before);
}

#[test]
fn current_future_replacements_and_conflicts_preserve_relevant_visibility() {
    let mut f = Fixture::new();
    let old = f.learn("reader original", None, &["reader.rs"]);
    let r1 = f.checkout().revision.commit;
    fs::write(f.root.join("retry.rs"), "fn retry() {}\n").unwrap();
    commit(&f.root);
    let new = f.learn("reader replacement", None, &["reader.rs"]);
    f.store
        .supersede(&f.checkout(), &actor(), old, new)
        .unwrap();
    let current = query(&f, "reader", &[], 5).0;
    assert!(!current.items.iter().any(|i| i["id"] == json!(old)));
    let r2 = f.checkout().revision.commit;
    git(&f.root, &["checkout", "--detach", &r1]);
    assert!(
        query(&f, "original", &[], 5)
            .0
            .items
            .iter()
            .any(|i| i["id"] == json!(old))
    );
    git(&f.root, &["checkout", "main"]);
    assert_eq!(f.checkout().revision.commit, r2);
    let other = f.learn("reader another replacement", None, &["reader.rs"]);
    f.store
        .supersede(&f.checkout(), &actor(), old, other)
        .unwrap();
    let conflict = query(&f, "original", &[], 5).0;
    assert_eq!(conflict.items[0]["relationship_conflict"], true);
    assert_eq!(conflict.items[0]["status"], "NeedsRevalidation");
}

#[test]
fn relevant_dirty_provisional_and_missing_history_remain_visible() {
    let mut f = Fixture::new();
    f.learn("reader committed", None, &["reader.rs"]);
    fs::write(
        f.root.join("reader.rs"),
        "fn read_bytes() { normalize(); }\n",
    )
    .unwrap();
    f.learn("reader provisional", None, &["reader.rs"]);
    let result = query(&f, "reader", &[], 5).0;
    assert_eq!(result.items[0]["status"], "NeedsRevalidation");
    assert_eq!(result.items[0]["evidence"][0]["comparison"], "Modified");
    assert_eq!(result.items[1]["status"], "Provisional");
    let mut events = f.events();
    replace_revision(&mut events, &"a".repeat(40));
    let checkout = f.checkout();
    let result = select(&checkout, &events, "reader", &BTreeSet::new(), 5, |p| {
        checkout.read(p)
    })
    .unwrap();
    assert_eq!(result.items[0]["history"], "unavailable_or_not_ancestor");
    assert_ne!(result.items[0]["status"], "Verified");
}

#[test]
fn explicit_review_changes_scope_and_invalid_inputs_read_nothing() {
    let mut f = Fixture::new();
    let id = f.learn("contract", None, &["reader.rs"]);
    let claims = crate::knowledge::projection::reduce(&f.events()).unwrap();
    let heads = crate::knowledge::reviews::active(&f.checkout(), &claims[&id])
        .unwrap()
        .ids();
    f.store
        .review(
            &f.checkout(),
            &actor(),
            crate::knowledge::ReviewRequest {
                knowledge: id,
                replaces: heads,
                paths: &["retry.rs".into()],
                promote: false,
            },
        )
        .unwrap();
    assert_eq!(query(&f, "reader", &[], 5).0.summary["status"], "no_match");
    assert_eq!(
        query(&f, "retry", &[], 5).0.items[0]["scope"],
        json!(["retry.rs"])
    );
    for (q, limit) in [("", 5), ("x", 0), ("x", 21)] {
        assert!(
            select(
                &f.checkout(),
                &f.events(),
                q,
                &BTreeSet::new(),
                limit,
                |_| -> anyhow::Result<Option<crate::source::SourceFile>> { panic!("no reads") }
            )
            .is_err()
        );
    }
}

#[test]
fn concurrent_review_edges_keep_disambiguating_review_ids() {
    let mut f = Fixture::new();
    let id = f.learn("reader contract", None, &["reader.rs"]);
    let checkout = f.checkout();
    let claims = crate::knowledge::projection::reduce(&f.events()).unwrap();
    let replaces = crate::knowledge::reviews::active(&checkout, &claims[&id])
        .unwrap()
        .ids();
    let review = f
        .store
        .review(
            &checkout,
            &actor(),
            crate::knowledge::ReviewRequest {
                knowledge: id,
                replaces,
                paths: &["reader.rs".into()],
                promote: false,
            },
        )
        .unwrap();
    let mut events = f.events();
    let mut sibling = events[&review].clone();
    sibling.id = EventId::new();
    events.insert(sibling.id, sibling);
    let selected = select(&checkout, &events, "reader", &BTreeSet::new(), 5, |p| {
        checkout.read(p)
    })
    .unwrap();
    assert_eq!(selected.items[0]["status"], "NeedsRevalidation");
    let support = selected.items[0]["evidence"].as_array().unwrap();
    assert_eq!(support.len(), 2);
    assert_ne!(support[0]["review"], support[1]["review"]);
    assert!(support[0]["review"].is_string());
}
