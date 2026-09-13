use super::*;
use tempfile::TempDir;

fn repository() -> RepositoryId {
    RepositoryId("tests/identity".into())
}
fn actor() -> Actor {
    Actor {
        id: "test-agent".into(),
        kind: ActorKind::Agent,
        harness: Some("test".into()),
        session: Some("session-1".into()),
    }
}
fn events(statement: &str) -> Vec<Event> {
    let repository = repository();
    let revision = Revision {
        repository: repository.clone(),
        commit: "a".repeat(40),
    };
    let id = KnowledgeId::new();
    let created = Event::new(
        &repository,
        &actor(),
        KnowledgeEvent::Created {
            claim: Claim {
                id,
                kind: KnowledgeKind::Architecture,
                statement: statement.into(),
                rationale: Some("observed ownership".into()),
                scope: vec!["src/auth.rs".into()],
                learned_at: revision.clone(),
                branch: Some("main".into()),
                dirty: false,
                provisional: false,
                default_branch: "main".into(),
            },
        },
    )
    .unwrap();
    let attached = Event::new(
        &repository,
        &actor(),
        KnowledgeEvent::EvidenceAttached {
            knowledge: id,
            evidence: FileEvidence {
                committed: None,
                anchor: None,
                path: "src/auth.rs".into(),
                sha256: fingerprint(b"fn rotate() {}"),
            },
        },
    )
    .unwrap();
    let verified = Event::new(
        &repository,
        &actor(),
        KnowledgeEvent::Verified {
            knowledge: id,
            revision,
            evidence: [attached.id].into_iter().collect(),
        },
    )
    .unwrap();
    vec![created, attached, verified]
}

#[test]
fn replay_deduplicates_and_recovers_projection_from_journal() {
    let state = TempDir::new().unwrap();
    let mut store = Store::open(state.path(), &repository()).unwrap();
    let mut events = events("Auth owns rotation");
    // Delivery order and clocks deliberately disagree with causal references.
    events[0].created_at_unix_ms = u64::MAX;
    events[2].created_at_unix_ms = 0;
    events.reverse();
    assert_eq!(store.append(&events).unwrap(), 3);
    assert_eq!(store.append(&events).unwrap(), 0);
    let claims = store.replay().unwrap();
    let k = claims.values().next().unwrap();
    assert_eq!(k.claim.statement, "Auth owns rotation");
    assert_eq!(k.evidence.len(), 1);
    assert_eq!(k.verifications.len(), 1);
    assert_eq!(
        k.verifications[0].evidence,
        [k.evidence[0].id].into_iter().collect()
    );
    assert_eq!(k.origin, actor());
    let before = serde_json::to_value(&claims).unwrap();
    drop(store);
    let db = state
        .path()
        .join("repositories")
        .join(fingerprint(repository().0.as_bytes()))
        .join("knowledge.sqlite");
    fs::remove_file(db).unwrap();
    let mut recovered = Store::open(state.path(), &repository()).unwrap();
    assert_eq!(
        serde_json::to_value(recovered.replay().unwrap()).unwrap(),
        before
    );
}

#[test]
fn id_collision_and_unknown_version_preserve_prior_state() {
    let state = TempDir::new().unwrap();
    let mut store = Store::open(state.path(), &repository()).unwrap();
    let events = events("claim");
    store.append(&events).unwrap();
    let mut bad = events[0].clone();
    bad.actor.id = "another actor".into();
    assert!(
        store
            .append(&[bad])
            .unwrap_err()
            .to_string()
            .contains("collision")
    );
    let mut bad = events[0].clone();
    bad.version = 99;
    assert!(
        store
            .append(&[bad])
            .unwrap_err()
            .to_string()
            .contains("unsupported")
    );
    let mut bad = events[0].clone();
    bad.repository = RepositoryId("other/repository".into());
    assert!(store.append(&[bad]).is_err());
    assert_eq!(store.journal.read().unwrap().len(), 3);
    assert_eq!(store.replay().unwrap().len(), 1);
}

#[test]
fn verification_cannot_reference_another_claims_evidence() {
    let mut events = events("claim A");
    let mut other = self::events("claim B");
    if let KnowledgeEvent::Verified { evidence, .. } = &mut other[2].payload {
        *evidence = [events[1].id].into_iter().collect();
    }
    events.extend(other);
    let state = TempDir::new().unwrap();
    let mut store = Store::open(state.path(), &repository()).unwrap();
    assert!(
        store
            .append(&events)
            .unwrap_err()
            .to_string()
            .contains("unattached")
    );
    assert!(store.journal.read().unwrap().is_empty());
}

#[test]
fn registry_union_is_concurrent_retryable_and_repository_scoped() {
    let registry = TempDir::new().unwrap();
    let first = events("claim A");
    let second = events("claim B");
    std::thread::scope(|scope| {
        for batch in [&first, &second, &first] {
            let root = registry.path();
            scope.spawn(move || {
                registry::LocalDirectoryRegistry::new(root, &repository())
                    .publish(batch)
                    .unwrap()
            });
        }
    });
    let registry = registry::LocalDirectoryRegistry::new(registry.path(), &repository());
    assert_eq!(registry.events().unwrap().len(), 6);
    assert_eq!(registry.publish(&first).unwrap(), 0);
    let state = TempDir::new().unwrap();
    let mut store = Store::open(state.path(), &repository()).unwrap();
    assert_eq!(store.pull(&registry).unwrap(), 6);
    assert_eq!(store.pull(&registry).unwrap(), 0);
    assert_eq!(store.replay().unwrap().len(), 2);
    let mut other = Store::open(state.path(), &RepositoryId("other/repository".into())).unwrap();
    assert!(other.pull(&registry).is_err());
    assert!(other.replay().unwrap().is_empty());
}

#[test]
fn pending_temporary_files_are_ignored_but_corrupt_segments_fail_closed() {
    let state = TempDir::new().unwrap();
    let mut store = Store::open(state.path(), &repository()).unwrap();
    store.append(&events("claim")).unwrap();
    let dir = state
        .path()
        .join("repositories")
        .join(fingerprint(repository().0.as_bytes()))
        .join("events");
    fs::write(dir.join(".pending-crash"), "incomplete").unwrap();
    assert_eq!(store.replay().unwrap().len(), 1);
    fs::write(dir.join("corrupt.json"), "incomplete").unwrap();
    assert!(store.replay().is_err());
    let count: i64 = store
        .connection
        .query_row("SELECT count(*) FROM knowledge", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 1);
}

#[test]
fn unsafe_relative_paths_are_rejected() {
    for path in [
        "",
        "/tmp/a",
        "../a",
        "a/../b",
        "a/./b",
        "./a",
        "a//b",
        "a\\b",
        ".git/config",
    ] {
        assert!(model::validate_path(path).is_err(), "{path}");
    }
    model::validate_path("src/auth.rs").unwrap();
}

fn review_event(base: &[Event], replaces: &[EventId], path: &str, promote: bool) -> Event {
    let KnowledgeEvent::Created { claim } = &base[0].payload else {
        panic!("created event")
    };
    Event::new(
        &repository(),
        &actor(),
        KnowledgeEvent::Reviewed {
            review: Review {
                knowledge: claim.id,
                revision: claim.learned_at.clone(),
                evidence: vec![FileEvidence {
                    committed: None,
                    anchor: None,
                    path: path.into(),
                    sha256: fingerprint(b"reviewed support"),
                }],
                replaces: replaces.iter().copied().collect(),
                promote,
                branch: "main".into(),
                default_branch: "main".into(),
            },
        },
    )
    .unwrap()
}

#[test]
fn reviews_replay_in_any_delivery_order_preserve_v1_bytes_and_recover_from_sqlite_loss() {
    let state = TempDir::new().unwrap();
    let mut legacy = events("unchanged conclusion");
    for event in &mut legacy {
        event.version = 1;
    }
    let directory = state
        .path()
        .join("repositories")
        .join(fingerprint(repository().0.as_bytes()));
    fs::create_dir_all(directory.join("events")).unwrap();
    // The exact v1 wire shape has no branch-policy or review fields.
    let bytes = serde_json::to_vec(&serde_json::json!({ "version": 1, "events": legacy })).unwrap();
    assert!(!String::from_utf8_lossy(&bytes).contains("default_branch"));
    fs::write(directory.join("events/legacy.json"), &bytes).unwrap();
    let mut store = Store::open(state.path(), &repository()).unwrap();
    let mut a = review_event(&legacy, &[legacy[2].id], "src/auth.rs", false);
    let mut b = review_event(&legacy, &[legacy[2].id], "docs/auth.md", false);
    a.created_at_unix_ms = u64::MAX;
    b.created_at_unix_ms = 0;
    let resolved = review_event(&legacy, &[a.id, b.id], "src/auth.rs", true);
    // Resolution arrives first inside the atomic batch; parent references still govern replay.
    let shuffled = vec![resolved.clone(), b.clone(), a.clone()];
    assert_eq!(store.append(&shuffled).unwrap(), 3);
    assert_eq!(store.append(&shuffled).unwrap(), 0);
    assert_eq!(
        fs::read(directory.join("events/legacy.json")).unwrap(),
        bytes
    );
    let expected = serde_json::to_value(store.replay().unwrap()).unwrap();
    let claims = store.replay().unwrap();
    let claim = claims.values().next().unwrap();
    assert_eq!(claim.reviews.len(), 3);
    assert_eq!(claim.verifications.len(), 1);
    assert_eq!(claim.evidence.len(), 1);
    let ordered = reviews::states(claim).unwrap();
    assert_eq!(ordered.last().unwrap().event, resolved.id);
    let opposite =
        projection::union(&repository(), legacy.into_iter().chain([a, b, resolved])).unwrap();
    assert_eq!(
        serde_json::to_value(projection::reduce(&opposite).unwrap()).unwrap(),
        expected
    );
    drop(store);
    fs::remove_file(directory.join("knowledge.sqlite")).unwrap();
    let mut recovered = Store::open(state.path(), &repository()).unwrap();
    assert_eq!(
        serde_json::to_value(recovered.replay().unwrap()).unwrap(),
        expected
    );
}

#[test]
fn review_references_reject_missing_cross_claim_and_cyclic_parents_without_writing() {
    let state = TempDir::new().unwrap();
    let mut store = Store::open(state.path(), &repository()).unwrap();
    let base = events("claim A");
    let other = events("claim B");
    store
        .append(&[base.clone(), other.clone()].concat())
        .unwrap();
    for parent in [EventId::new(), base[1].id, other[2].id] {
        let bad = review_event(&base, &[parent], "src/auth.rs", false);
        assert!(store.append(&[bad]).is_err());
    }
    let mut a = review_event(&base, &[base[2].id], "src/auth.rs", false);
    let b = review_event(&base, &[a.id], "src/auth.rs", false);
    if let KnowledgeEvent::Reviewed { review } = &mut a.payload {
        review.replaces = [b.id].into_iter().collect();
    }
    assert!(
        store
            .append(&[a, b])
            .unwrap_err()
            .to_string()
            .contains("cycle")
    );
    assert_eq!(store.journal.read().unwrap().len(), 6);
    assert!(
        store
            .replay()
            .unwrap()
            .values()
            .all(|k| k.reviews.is_empty())
    );
}

#[test]
fn projection_v1_upgrades_only_after_successful_replay_and_future_data_fails_safely() {
    let state = TempDir::new().unwrap();
    let mut store = Store::open(state.path(), &repository()).unwrap();
    store.append(&events("claim")).unwrap();
    store
        .connection
        .pragma_update(None, "user_version", 1)
        .unwrap();
    store
        .connection
        .execute(
            "UPDATE knowledge SET payload = 'old projection payload'",
            [],
        )
        .unwrap();
    let directory = state
        .path()
        .join("repositories")
        .join(fingerprint(repository().0.as_bytes()));
    let future = directory.join("events/future.json");
    fs::write(&future, r#"{"version":99,"events":[]}"#).unwrap();
    drop(store);
    let mut store = Store::open(state.path(), &repository()).unwrap();
    assert!(store.replay().is_err());
    let version: u32 = store
        .connection
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .unwrap();
    assert_eq!(version, 1);
    let payload: String = store
        .connection
        .query_row("SELECT payload FROM knowledge", [], |r| r.get(0))
        .unwrap();
    assert_eq!(payload, "old projection payload");
    fs::remove_file(future).unwrap();
    assert_eq!(store.replay().unwrap().len(), 1);
    let version: u32 = store
        .connection
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .unwrap();
    assert_eq!(version, 2);
    store
        .connection
        .pragma_update(None, "user_version", 99)
        .unwrap();
    drop(store);
    assert!(Store::open(state.path(), &repository()).is_err());
}

#[test]
fn version_one_cannot_smuggle_new_review_or_branch_policy_semantics() {
    let mut base = events("claim");
    let mut review = review_event(&base, &[base[2].id], "src/auth.rs", false);
    review.version = 1;
    assert!(review.validate(&repository()).is_err());
    base[0].version = 1;
    if let KnowledgeEvent::Created { claim } = &mut base[0].payload {
        claim.default_branch = "trunk".into();
        claim.branch = Some("trunk".into());
    }
    assert!(base[0].validate(&repository()).is_err());
}
