use super::*;

fn codes(item: &Value) -> Vec<&str> {
    item["attention"]["reasons"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["code"].as_str().unwrap())
        .collect()
}
fn inspection(f: &Fixture, id: &str, extra: &[&str]) -> std::path::PathBuf {
    let mut args = vec!["maintenance", id];
    args.extend_from_slice(extra);
    let value = f.run("a", &args);
    let path = f
        .temp
        .path()
        .join(format!("inspection-{}.json", uuid::Uuid::now_v7()));
    fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
    path
}
fn assessed(f: &Fixture, path: &Path, extra: &[&str]) -> Output {
    let mut args = vec![
        "review",
        "--assessment",
        path.to_str().unwrap(),
        "--reviewed",
        "--actor",
        "reviewer",
    ];
    args.extend_from_slice(extra);
    f.output("a", &args)
}
fn succeeded(output: Output) -> Value {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn queue_reasons_shared_reads_age_and_pagination_are_event_free() {
    let f = Fixture::new();
    let mut ids = Vec::new();
    for n in 0..5 {
        ids.push(f.learn(
            "a",
            &format!("{n} {}", "complete statement ".repeat(18)),
            "auth.rs",
        ));
    }
    ids.push(f.learn("a", "retry support", "retry.rs"));
    let before = journal_bytes(&f, "a");
    assert!(
        f.run("a", &["maintenance"])["items"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    fs::write(f.root("a").join("auth.rs"), "// changed\nfn rotate() {}\n").unwrap();
    fs::remove_file(f.root("a").join("retry.rs")).unwrap();
    let queue = f.run("a", &["maintenance", "--review-before", "9999-01-01"]);
    assert_eq!(queue["files_read"], 2);
    assert_eq!(queue["assessed"], 6);
    for item in queue["items"].as_array().unwrap() {
        assert!(codes(item).contains(&"review_due"));
        assert!(
            codes(item).contains(&"evidence_changed") || codes(item).contains(&"evidence_missing")
        );
        assert!(
            item["attention"]["action_blockers"]
                .as_array()
                .unwrap()
                .contains(&serde_json::json!("clean_checkout_required"))
        );
    }
    let mut cursor = None::<String>;
    let mut found = vec![];
    loop {
        let mut args = vec![
            "maintenance",
            "--review-before",
            "9999-01-01",
            "--max-bytes",
            "3000",
        ];
        if let Some(after) = &cursor {
            args.extend(["--after", after]);
        }
        let output = f.output("a", &args);
        assert!(output.stdout.len() <= 3000);
        let page = succeeded(output);
        for item in page["items"].as_array().unwrap() {
            found.push(item["id"].as_str().unwrap().to_owned());
            assert!(!item["statement"].as_str().unwrap().is_empty());
        }
        cursor = page["next_after"].as_str().map(str::to_owned);
        if cursor.is_none() {
            break;
        }
    }
    assert_eq!(found, ids);
    assert_eq!(before, journal_bytes(&f, "a"));
    assert!(
        !f.output("a", &["maintenance", "--review-before", "2025-02-29"])
            .status
            .success()
    );
    assert!(
        f.output("a", &["maintenance", "--review-before", "2024-02-29"])
            .status
            .success()
    );
    assert!(
        !f.output(
            "a",
            &["maintenance", "--after", &uuid::Uuid::now_v7().to_string()]
        )
        .status
        .success()
    );
}

#[test]
fn future_and_retired_reviews_do_not_queue_valid_current_knowledge() {
    let f = Fixture::new();
    let id = f.learn("a", "auth contract", "auth.rs");
    f.sync();
    let heads_before = heads(&f.run("b", &["orient"]), &id);
    fs::write(f.root("b").join("auth.rs"), "fn rotate() { newer(); }\n").unwrap();
    commit(&f.root("b"));
    review(&f, "b", &id, &["auth.rs"], &heads_before, false);
    transfer(&f, "b", "a");
    // The future commit is initially unavailable, then available but not ancestral.
    assert!(
        f.run("a", &["maintenance"])["items"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    git(
        &f.root("a"),
        &["fetch", f.root("b").to_str().unwrap(), "main"],
    );
    assert!(
        f.run("a", &["maintenance"])["items"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    git(&f.root("a"), &["merge", "--ff-only", "FETCH_HEAD"]);
    assert!(
        f.run("a", &["maintenance"])["items"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let detail = f.run("a", &["maintenance", &id]);
    assert_eq!(detail["recorded_support"].as_array().unwrap().len(), 1);
    let history = f.run("a", &["maintenance", &id, "--history"]);
    assert!(history["reviews"].as_array().unwrap().len() >= 3);
}

#[test]
fn selected_support_diff_pages_preserve_complete_utf8_and_dirty_bytes() {
    let f = Fixture::new();
    let original = "// café 😀\r\n".repeat(220);
    fs::write(f.root("a").join("auth.rs"), &original).unwrap();
    commit(&f.root("a"));
    let id = f.learn("a", "raw source support", "auth.rs");
    let current = format!("// dirty header\n{original}// tail\n");
    fs::write(f.root("a").join("auth.rs"), &current).unwrap();
    let before = journal_bytes(&f, "a");
    let detail = f.run("a", &["maintenance", &id]);
    assert_eq!(
        detail["item"]["knowledge"]["claim"]["statement"],
        "raw source support"
    );
    assert!(
        detail["diffs"][0]["text"]
            .as_str()
            .unwrap()
            .contains("+// dirty header")
    );
    for (view, expected) in [
        ("current", current.as_str()),
        ("recorded", original.as_str()),
    ] {
        let mut offset = 0;
        let mut reconstructed = String::new();
        loop {
            let output = f.output(
                "a",
                &[
                    "maintenance",
                    &id,
                    "--source",
                    "auth.rs",
                    "--view",
                    view,
                    "--offset",
                    &offset.to_string(),
                    "--max-bytes",
                    "2400",
                ],
            );
            assert!(output.stdout.len() <= 2400);
            let page = succeeded(output);
            let text = page["text"].as_str().unwrap();
            let end = page["end"].as_u64().unwrap() as usize;
            assert_eq!(&expected[offset..end], text);
            let start_line = 1 + expected[..offset].bytes().filter(|b| *b == b'\n').count();
            let end_line = 1 + expected[..if end > offset { end - 1 } else { end }]
                .bytes()
                .filter(|b| *b == b'\n')
                .count();
            assert_eq!(page["lines"], serde_json::json!([start_line, end_line]));
            reconstructed.push_str(text);
            match page["next_offset"].as_u64() {
                Some(next) => {
                    assert!(next as usize > offset);
                    offset = next as usize
                }
                None => break,
            }
        }
        assert_eq!(reconstructed, expected);
    }
    assert_eq!(before, journal_bytes(&f, "a"));
}

#[test]
fn missing_history_and_dirty_recorded_support_are_explicit() {
    let f = Fixture::new();
    let id = f.learn("a", "auth contract", "auth.rs");
    f.sync();
    let head = heads(&f.run("a", &["orient"]), &id)[0].clone();
    fs::write(f.root("a").join("auth.rs"), "fn rotate() { newer(); }\n").unwrap();
    commit(&f.root("a"));
    git(
        f.temp.path(),
        &[
            "clone",
            "--depth",
            "1",
            &format!("file://{}", f.root("a").display()),
            f.root("shallow").to_str().unwrap(),
        ],
    );
    f.run(
        "shallow",
        &[
            "pull",
            "--registry",
            f.temp.path().join("registry").to_str().unwrap(),
        ],
    );
    let queue = f.run("shallow", &["maintenance"]);
    assert!(codes(&queue["items"][0]).contains(&"history_unavailable"));
    let page = f.run(
        "shallow",
        &[
            "maintenance",
            &id,
            "--source",
            "auth.rs",
            "--view",
            "recorded",
            "--review",
            &head,
        ],
    );
    assert!(
        page["unavailable"]
            .as_str()
            .unwrap()
            .contains("unavailable")
    );
    fs::write(f.root("a").join("auth.rs"), "uncommitted evidence\n").unwrap();
    let dirty = f.learn("a", "dirty source claim", "auth.rs");
    let page = f.run(
        "a",
        &[
            "maintenance",
            &dirty,
            "--source",
            "auth.rs",
            "--view",
            "recorded",
        ],
    );
    assert!(
        page["unavailable"]
            .as_str()
            .unwrap()
            .contains("do not match")
    );
}

#[test]
fn assessed_review_rejects_stale_checkout_bytes_heads_and_uninspected_support() {
    let f = Fixture::new();
    let id = f.learn("a", "auth contract", "auth.rs");
    let old = inspection(&f, &id, &[]);
    f.sync();
    let other_checkout = f.output(
        "b",
        &[
            "review",
            "--assessment",
            old.to_str().unwrap(),
            "--reviewed",
            "--actor",
            "reviewer",
        ],
    );
    assert!(!other_checkout.status.success());
    assert!(String::from_utf8_lossy(&other_checkout.stderr).contains("stale assessment"));
    let before = journal_bytes(&f, "a");
    fs::write(f.root("a").join("auth.rs"), "changed source\n").unwrap();
    let failure = assessed(&f, &old, &[]);
    assert!(!failure.status.success());
    assert!(String::from_utf8_lossy(&failure.stderr).contains("stale assessment"));
    commit(&f.root("a"));
    assert!(!assessed(&f, &old, &[]).status.success());
    assert_eq!(before, journal_bytes(&f, "a"));
    let fresh = inspection(&f, &id, &[]);
    assert!(
        !assessed(&f, &fresh, &["--evidence", "retry.rs"])
            .status
            .success()
    );
    // An unrelated learned claim does not invalidate this selected assessment.
    f.learn("a", "unrelated retries", "retry.rs");
    succeeded(assessed(&f, &fresh, &[]));
    assert!(!assessed(&f, &fresh, &[]).status.success());
    let fresh = inspection(&f, &id, &[]);
    git(&f.root("a"), &["checkout", "-b", "topic"]);
    assert!(!assessed(&f, &fresh, &[]).status.success());
    git(&f.root("a"), &["checkout", "main"]);
    let extra = inspection(&f, &id, &["--evidence", "retry.rs"]);
    succeeded(assessed(&f, &extra, &["--evidence", "retry.rs"]));
    let detail = f.run("a", &["maintenance", &id]);
    assert_eq!(
        detail["assessment"]["support_paths"],
        serde_json::json!(["retry.rs"])
    );
}

#[test]
fn explicit_complete_support_can_retire_missing_paths_without_implicit_promotion() {
    let f = Fixture::new();
    git(&f.root("a"), &["checkout", "-b", "topic"]);
    let id = f.learn("a", "auth contract", "auth.rs");
    let queued = f.run("a", &["maintenance"]);
    assert!(
        queued["items"][0]["attention"]["promotion"]["blockers"]
            .as_array()
            .unwrap()
            .contains(&serde_json::json!("default_branch_required"))
    );
    git(&f.root("a"), &["checkout", "main"]);
    fs::remove_file(f.root("a").join("auth.rs")).unwrap();
    commit(&f.root("a"));
    let view = f.run("a", &["maintenance", &id]);
    assert!(view["attention"]["promotion"]["needed"].as_bool().unwrap());
    assert!(
        !view["attention"]["promotion"]["eligible_with_current_support"]
            .as_bool()
            .unwrap()
    );
    let reference = inspection(&f, &id, &["--evidence", "retry.rs"]);
    succeeded(assessed(&f, &reference, &["--evidence", "retry.rs"]));
    assert_eq!(
        f.run("a", &["maintenance", &id])["item"]["status"],
        "Provisional"
    );
    let reference = inspection(&f, &id, &[]);
    succeeded(assessed(&f, &reference, &["--promote"]));
    assert_eq!(
        f.run("a", &["maintenance", &id])["item"]["status"],
        "Verified"
    );
}

#[test]
fn replacement_is_one_existing_event_batch_and_replays_across_instances() {
    let f = Fixture::new();
    let id = f.learn("a", "old auth contract", "auth.rs");
    let reference = inspection(&f, &id, &[]);
    let before = journal_bytes(&f, "a");
    let base = [
        "--assessment",
        reference.to_str().unwrap(),
        "--reviewed",
        "--actor",
        "reviewer",
    ];
    let mut invalid = vec!["replace", "old auth contract"];
    invalid.extend(base);
    assert!(!f.output("a", &invalid).status.success());
    assert_eq!(before, journal_bytes(&f, "a"));
    let mut args = vec!["replace", "qualified current auth contract"];
    args.extend(base);
    let result = f.run("a", &args);
    let new = result["knowledge_id"].as_str().unwrap();
    let after = journal_bytes(&f, "a");
    assert_eq!(after.len(), before.len() + 1);
    let segment = after.iter().find(|bytes| !before.contains(bytes)).unwrap();
    let segment: Value = serde_json::from_slice(segment).unwrap();
    assert_eq!(segment["version"], 2);
    let types: Vec<_> = segment["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["payload"]["type"].as_str().unwrap())
        .collect();
    assert_eq!(
        types,
        vec!["Created", "EvidenceAttached", "Verified", "Superseded"]
    );
    assert_eq!(
        f.run("a", &["maintenance", &id])["item"]["status"],
        "Superseded"
    );
    assert!(
        f.run("a", &["maintenance"])["items"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    f.sync();
    assert_eq!(f.run("b", &["show", new])["item"]["status"], "Verified");
    assert_eq!(f.run("a", &["replay"])["materialized_claims"], 2);
    assert_eq!(
        f.run("a", &["show", &id])["item"]["knowledge"]["claim"]["statement"],
        "old auth contract"
    );
}

#[test]
fn concurrent_assessed_writers_cannot_both_accept_the_same_heads() {
    let f = Fixture::new();
    let id = f.learn("a", "auth contract", "auth.rs");
    let reference = inspection(&f, &id, &[]);
    let before = journal_bytes(&f, "a");
    let results = std::thread::scope(|scope| {
        let a = scope.spawn(|| assessed(&f, &reference, &[]));
        let b = scope.spawn(|| assessed(&f, &reference, &[]));
        [a.join().unwrap(), b.join().unwrap()]
    });
    assert_eq!(results.iter().filter(|r| r.status.success()).count(), 1);
    assert!(
        results
            .iter()
            .filter(|r| !r.status.success())
            .all(|r| String::from_utf8_lossy(&r.stderr).contains("stale assessment"))
    );
    assert_eq!(journal_bytes(&f, "a").len(), before.len() + 1);
}

#[test]
fn unavailable_utf8_is_reported_and_bound_to_exact_bytes() {
    let f = Fixture::new();
    let id = f.learn("a", "auth contract", "auth.rs");
    fs::write(f.root("a").join("auth.rs"), [0xff, 0x00]).unwrap();
    let view = f.run("a", &["maintenance", &id]);
    assert!(
        view["attention"]["reasons"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["code"] == "evidence_unavailable")
    );
    assert!(view["assessment"]["observed"]["auth.rs"]["sha256"].is_string());
    let reference = inspection(&f, &id, &[]);
    fs::write(f.root("a").join("auth.rs"), [0xfe, 0x00]).unwrap();
    let output = assessed(&f, &reference, &[]);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("evidence 'auth.rs' changed"));
}

#[test]
fn assessed_review_explicitly_resolves_every_concurrent_head() {
    let f = Fixture::new();
    let id = f.learn("a", "auth contract", "auth.rs");
    f.sync();
    let original = heads(&f.run("a", &["orient"]), &id);
    review(&f, "a", &id, &["auth.rs"], &original, false);
    review(&f, "b", &id, &["auth.rs"], &original, false);
    transfer(&f, "b", "a");
    let queue = f.run("a", &["maintenance"]);
    assert!(codes(&queue["items"][0]).contains(&"review_conflict"));
    let reference = inspection(&f, &id, &[]);
    let value: Value = serde_json::from_slice(&fs::read(&reference).unwrap()).unwrap();
    assert_eq!(
        value["assessment"]["review_heads"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    succeeded(assessed(&f, &reference, &[]));
    assert!(
        f.run("a", &["maintenance"])["items"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn changed_meaning_must_be_an_explicit_statement_and_failed_batch_leaves_no_claim() {
    let f = Fixture::new();
    let id = f.learn("a", "old statement", "auth.rs");
    let reference = inspection(&f, &id, &[]);
    let before = journal_bytes(&f, "a");
    let missing_assertion = f.output(
        "a",
        &[
            "replace",
            "new statement",
            "--assessment",
            reference.to_str().unwrap(),
            "--actor",
            "reviewer",
        ],
    );
    assert!(!missing_assertion.status.success());
    let bad_actor = f.output(
        "a",
        &[
            "replace",
            "new statement",
            "--assessment",
            reference.to_str().unwrap(),
            "--actor",
            "",
            "--reviewed",
        ],
    );
    assert!(!bad_actor.status.success());
    assert_eq!(journal_bytes(&f, "a"), before);
    assert_eq!(f.run("a", &["replay"])["materialized_claims"], 1);
}

#[test]
fn missing_review_support_and_relationship_conflicts_have_distinct_blockers() {
    let f = Fixture::new();
    let id = f.learn("a", "unreviewed contract", "auth.rs");
    let bytes = journal_bytes(&f, "a");
    let segment: Value = serde_json::from_slice(&bytes[0]).unwrap();
    let mut created = segment["events"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["payload"]["type"] == "Created")
        .unwrap()
        .clone();
    created["payload"]["claim"]["provisional"] = serde_json::json!(true);
    f.run("b", &["maintenance"]);
    let directory = fs::read_dir(f.temp.path().join("state-b/repositories"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path()
        .join("events");
    fs::create_dir(&directory).unwrap();
    fs::write(
        directory.join("unreviewed.json"),
        serde_json::to_vec(&serde_json::json!({"version":2,"events":[created]})).unwrap(),
    )
    .unwrap();
    let queue = f.run("b", &["maintenance"]);
    let entry = &queue["items"][0];
    assert_eq!(entry["id"], id);
    assert!(codes(entry).contains(&"missing_complete_review"));
    assert_eq!(entry["scope"], serde_json::json!(["auth.rs"]));
    assert!(
        !entry["attention"]["promotion"]["eligible_with_current_support"]
            .as_bool()
            .unwrap()
    );
    assert!(
        entry["attention"]["action_blockers"]
            .as_array()
            .unwrap()
            .contains(&serde_json::json!("complete_support_required"))
    );
    let a = f.learn("a", "replacement one", "auth.rs");
    let b = f.learn("a", "replacement two", "auth.rs");
    f.run("a", &["supersede", &id, &a, "--actor", "reviewer"]);
    f.run("a", &["supersede", &id, &b, "--actor", "reviewer"]);
    let queue = f.run("a", &["maintenance"]);
    assert!(codes(&queue["items"][0]).contains(&"relationship_conflict"));
    let assessment = inspection(&f, &id, &[]);
    let before = journal_bytes(&f, "a");
    assert!(!assessed(&f, &assessment, &[]).status.success());
    assert_eq!(before, journal_bytes(&f, "a"));
}

#[test]
fn precise_cli_default_retains_anchors_and_requires_inspected_explicit_changes() {
    let f = Fixture::new();
    let selector = serde_json::json!({"version":1,"kind":"function","name":"rotate","owners":[]});
    let anchor = serde_json::json!({"path":"auth.rs","selector":selector}).to_string();
    let result = f.run(
        "a",
        &[
            "learn",
            "rotation behavior",
            "--actor",
            "reviewer",
            "--anchor",
            &anchor,
            "--evidence",
            "retry.rs",
        ],
    );
    let id = result["knowledge_id"].as_str().unwrap();
    let before = inspection(&f, id, &[]);
    assert_eq!(
        succeeded(assessed(&f, &before, &[]))["promotion_requested"],
        false
    );
    let detail = f.run("a", &["maintenance", id]);
    assert_eq!(detail["assessment"]["support"].as_array().unwrap().len(), 2);
    let region = f.run(
        "a",
        &[
            "maintenance",
            id,
            "--source",
            "auth.rs",
            "--selector",
            &selector.to_string(),
            "--view",
            "recorded",
        ],
    );
    assert!(region["unavailable"].is_null(), "{region}");
    assert!(region["text"].as_str().unwrap().contains("rotate"));
    fs::write(
        f.root("a").join("auth.rs"),
        "// unrelated change\nfn rotate() { auth_service(); }\n",
    )
    .unwrap();
    assert_eq!(
        f.run("a", &["maintenance", id])["item"]["status"],
        "Verified"
    );
}
