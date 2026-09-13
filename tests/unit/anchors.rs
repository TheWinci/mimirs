use super::*;
use crate::{
    context::test_support::{self as support, Fixture},
    context::{self, maintenance},
    knowledge::{self, Store, model::*},
};
use std::{collections::BTreeSet, fs};
fn spec(path: &str, name: &str) -> Spec {
    Spec {
        path: path.into(),
        selector: Some(Selector {
            version: 1,
            kind: "function".into(),
            name: name.into(),
            owners: vec![],
        }),
        provider: None,
    }
}
fn learn(f: &mut Fixture, specs: &[Spec]) -> KnowledgeId {
    f.store
        .learn_with_evidence(
            &f.checkout(),
            &support::actor(),
            KnowledgeKind::Invariant,
            "reader preserves bytes",
            None,
            specs,
        )
        .unwrap()
}
fn inspect(f: &Fixture, id: KnowledgeId) -> maintenance::Inspection {
    maintenance::inspect(&f.checkout(), &f.events(), id, &[]).unwrap()
}
#[test]
fn unrelated_edits_and_shifted_spans_match_but_declaration_attributes_change() {
    let mut f = Fixture::new();
    fs::write(
        f.root.join("reader.rs"),
        "#[inline]\npub fn read_bytes() { preserve_original(); }\nfn other() {}\n",
    )
    .unwrap();
    support::commit(&f.root);
    let id = learn(&mut f, &[spec("reader.rs", "read_bytes")]);
    let initial = inspect(&f, id);
    assert_eq!(initial.item.status, context::Status::Verified);
    let old = initial.item.evidence[0].anchor.clone().unwrap();
    fs::write(f.root.join("reader.rs"),"// unrelated header\n\n#[inline]\npub fn read_bytes() { preserve_original(); }\nfn other() { changed(); }\n").unwrap();
    let shifted = inspect(&f, id);
    assert_eq!(shifted.item.status, context::Status::Verified);
    assert_ne!(
        old["current_regions"],
        shifted.item.evidence[0].anchor.as_ref().unwrap()["current_regions"]
    );
    assert_ne!(
        shifted.item.evidence[0].expected_sha256,
        shifted.item.evidence[0].current_sha256.clone().unwrap()
    );
    fs::write(
        f.root.join("reader.rs"),
        "#[inline(never)]\npub fn read_bytes() { preserve_original(); }\n",
    )
    .unwrap();
    assert_eq!(
        inspect(&f, id).item.status,
        context::Status::NeedsRevalidation
    );
}
#[test]
fn owner_headers_named_parent_and_duplicates_are_conservative() {
    let source = |text: &str| SourceFile {
        path: "a.rs".into(),
        text: text.into(),
    };
    let selector = Selector {
        version: 1,
        kind: "method".into(),
        name: "read".into(),
        owners: vec![Named {
            kind: "impl".into(),
            name: "Reader for Disk".into(),
        }],
    };
    let first = resolve(
        &source("impl Reader for Disk { fn read(&self) {} }"),
        &selector,
        None,
    )
    .unwrap();
    let generic = resolve(
        &source("impl<T> Reader for Disk where T: Copy { fn read(&self) {} }"),
        &selector,
        None,
    )
    .unwrap();
    assert_ne!(first.region_sha256, generic.region_sha256);
    assert!(
        resolve(
            &source("impl Reader for Other { fn read(&self) {} }"),
            &selector,
            None
        )
        .is_err()
    );
    assert!(
        resolve(
            &source("impl Reader for Disk { fn read(&self) {} fn read(&self) {} }"),
            &selector,
            None
        )
        .is_err()
    );
    assert!(
        resolve(
            &source("impl Reader for Disk { fn renamed(&self) {} }"),
            &selector,
            None
        )
        .is_err()
    );
    assert!(
        resolve(
            &SourceFile {
                path: "a.py".into(),
                text: "def read(): pass".into()
            },
            &selector,
            None
        )
        .is_err()
    );
    assert!(
        resolve(
            &source("fn outer(){ fn read() {} }"),
            &Selector {
                kind: "function".into(),
                name: "read".into(),
                owners: vec![Named {
                    kind: "function".into(),
                    name: "outer".into()
                }],
                version: 1
            },
            None
        )
        .is_err()
    );
    assert!(
        resolve(
            &source("impl Reader for Disk { fn read(&self) {} }"),
            &selector,
            Some("old-extractor")
        )
        .is_err()
    );
    let file_selector = Selector {
        version: 1,
        kind: "function".into(),
        name: "read".into(),
        owners: vec![],
    };
    assert!(
        resolve(
            &source(r#"unsafe extern "C" { fn read(); }"#),
            &file_selector,
            None
        )
        .is_err()
    );
    let mut future = file_selector;
    future.version = 2;
    assert!(resolve(&source("fn read() {}"), &future, None).is_err());
}
#[test]
fn typed_default_review_replace_dependencies_and_stale_writes() {
    let mut f = Fixture::new();
    fs::write(
        f.root.join("reader.rs"),
        "fn read_bytes() {}\nfn second() {}\n",
    )
    .unwrap();
    support::commit(&f.root);
    let specs = vec![
        spec("reader.rs", "read_bytes"),
        spec("reader.rs", "second"),
        Spec::file("retry.rs"),
    ];
    let id = learn(&mut f, &specs);
    let reference = inspect(&f, id).reference;
    assert_eq!(reference.version, 2);
    assert_eq!(reference.support.len(), 3);
    assert_eq!(reference.observed.len(), 2);
    fs::write(f.root.join("retry.rs"), "fn changed_dependency() {}\n").unwrap();
    assert_eq!(
        inspect(&f, id).item.status,
        context::Status::NeedsRevalidation
    );
    assert!(
        f.store
            .review_assessed(&f.checkout(), &support::actor(), &reference, None, false)
            .is_err()
    );
    support::commit(&f.root);
    let reference = inspect(&f, id).reference;
    f.store
        .review_assessed(&f.checkout(), &support::actor(), &reference, None, false)
        .unwrap();
    let fresh = inspect(&f, id);
    assert_eq!(fresh.item.status, context::Status::Verified);
    assert_eq!(fresh.reference.support.len(), 3);
    assert_eq!(
        fresh
            .reference
            .support
            .iter()
            .filter(|s| s.selector.is_some())
            .count(),
        2
    );
    let new = f
        .store
        .replace_assessed(
            &f.checkout(),
            &support::actor(),
            knowledge::ReplacementRequest {
                assessment: &fresh.reference,
                statement: "qualified reader preserves bytes",
                rationale: None,
                kind: None,
                paths: None,
                support: None,
            },
        )
        .unwrap();
    assert_eq!(inspect(&f, new).reference.support.len(), 3);
    assert_eq!(inspect(&f, id).item.status, context::Status::Superseded);
    let selector = spec("retry.rs", "changed_dependency");
    let reference = inspect(&f, new).reference;
    assert!(
        f.store
            .review_assessed_with_evidence(
                &f.checkout(),
                &support::actor(),
                &reference,
                Some(std::slice::from_ref(&selector)),
                false
            )
            .is_err()
    );
    let reference = maintenance::inspect_typed(
        &f.checkout(),
        &f.events(),
        new,
        std::slice::from_ref(&selector),
    )
    .unwrap()
    .reference;
    f.store
        .review_assessed_with_evidence(
            &f.checkout(),
            &support::actor(),
            &reference,
            Some(&[selector]),
            false,
        )
        .unwrap();
    assert_eq!(inspect(&f, new).reference.support.len(), 1);
}
#[test]
fn legacy_and_v3_exchange_preserves_journal_and_rejects_incompatible_versions() {
    let mut f = Fixture::new();
    let old = f.learn("whole file claim", None, &["reader.rs"]);
    let legacy = f.journal();
    let id = learn(&mut f, &[spec("reader.rs", "read_bytes")]);
    let registry = knowledge::registry::LocalDirectoryRegistry::new(
        &f._temp.path().join("registry"),
        &f.repository,
    );
    f.store.publish(&registry).unwrap();
    let mut other = Store::open(&f._temp.path().join("other"), &f.repository).unwrap();
    other.pull(&registry).unwrap();
    assert_eq!(other.events().unwrap(), f.events());
    let original: std::collections::BTreeMap<EventId, Event> =
        serde_json::from_slice(&legacy).unwrap();
    for (key, event) in original {
        assert_eq!(
            serde_json::to_vec(&f.events()[&key]).unwrap(),
            serde_json::to_vec(&event).unwrap()
        );
    }
    assert!(inspect(&f, old).item.evidence[0].anchor.is_none());
    let mut events = f.events();
    let event=events.values_mut().find(|e|matches!(&e.payload,KnowledgeEvent::EvidenceAttached{knowledge,..} if *knowledge==id)).unwrap();
    assert_eq!(event.version, 3);
    event.version = 2;
    assert!(event.validate(&f.repository).is_err());
    event.version = 4;
    assert!(event.validate(&f.repository).is_ok());
    event.version = 5;
    assert!(event.validate(&f.repository).is_err());
    event.version = 3;
    if let KnowledgeEvent::EvidenceAttached { evidence, .. } = &mut event.payload {
        evidence.anchor.as_mut().unwrap().provider = "previous extractor".into();
    }
    let result = maintenance::inspect(&f.checkout(), &events, id, &[]).unwrap();
    assert_eq!(result.item.status, context::Status::NeedsRevalidation);
    assert!(matches!(
        result.item.evidence[0].comparison,
        context::Comparison::Unavailable
    ));
    let explicit = spec("reader.rs", "read_bytes");
    let detail = maintenance::detail(
        &f.checkout(),
        &events,
        id,
        16000,
        maintenance::DetailOptions {
            source: Some("reader.rs"),
            selector: explicit.selector.as_ref(),
            anchors: std::slice::from_ref(&explicit),
            view: Some(maintenance::View::Current),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(detail["unavailable"].is_null(), "{detail}");
}
#[test]
fn anchor_pages_are_region_bounded_and_task_context_distinguishes_same_path_support() {
    let mut f = Fixture::new();
    fs::write(
        f.root.join("reader.rs"),
        "fn read_bytes() {}\nfn second() {}\nfn unrelated() { enormous_unrelated_context(); }\n",
    )
    .unwrap();
    support::commit(&f.root);
    let a = spec("reader.rs", "read_bytes");
    let id = learn(&mut f, &[a.clone(), spec("reader.rs", "second")]);
    let page = maintenance::detail(
        &f.checkout(),
        &f.events(),
        id,
        16000,
        maintenance::DetailOptions {
            source: Some("reader.rs"),
            selector: a.selector.as_ref(),
            view: Some(maintenance::View::Recorded),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(page["unavailable"].is_null(), "{page}");
    assert!(page["text"].as_str().unwrap().contains("fn read_bytes"));
    assert!(!page["text"].as_str().unwrap().contains("unrelated"));
    fs::write(
        f.root.join("reader.rs"),
        "fn read_bytes() { changed(); }\nfn second() {}\n",
    )
    .unwrap();
    let diff = maintenance::detail(
        &f.checkout(),
        &f.events(),
        id,
        16000,
        maintenance::DetailOptions {
            source: Some("reader.rs"),
            selector: a.selector.as_ref(),
            view: Some(maintenance::View::Diff),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(diff["text"].as_str().unwrap().contains("changed()"));
    let selection = context::query::select(
        &f.checkout(),
        &f.events(),
        "reader preserves",
        &BTreeSet::new(),
        5,
        |p| f.checkout().read(p),
    )
    .unwrap();
    assert_eq!(selection.summary["evidence_paths"], 1);
    assert_eq!(selection.items[0]["evidence"].as_array().unwrap().len(), 2);
    assert_ne!(
        selection.items[0]["evidence"][0]["anchor"]["selector"],
        selection.items[0]["evidence"][1]["anchor"]["selector"]
    );
    let mut unavailable = f.events();
    support::replace_revision(&mut unavailable, &"f".repeat(40));
    let revision_missing = maintenance::detail(
        &f.checkout(),
        &unavailable,
        id,
        16000,
        maintenance::DetailOptions {
            source: Some("reader.rs"),
            selector: a.selector.as_ref(),
            view: Some(maintenance::View::Recorded),
            review: Some(inspect(&f, id).item.assessed_review.unwrap()),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(
        revision_missing["unavailable"]
            .as_str()
            .unwrap()
            .contains("unavailable")
    );
}
