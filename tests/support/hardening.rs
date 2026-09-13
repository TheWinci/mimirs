use super::*;

#[test]
fn safe_git_helpers_and_typed_conversion_blockers_preserve_maintenance() {
    let f = Fixture::new();
    let bad = f.learn("a", "Authentication contract", "auth.rs");
    let good = f.learn("a", "Retry contract", "retry.rs");
    let root = f.root("a");
    let before = journal_bytes(&f, "a");
    // Built-in ident is unsupported for writes, but does not hide other claims or history.
    fs::write(root.join(".git/info/attributes"), "auth.rs ident\n").unwrap();
    fs::write(root.join("retry.rs"), "const RETRIES: usize = 7;\n").unwrap();
    let queue = f.run("a", &["maintenance"]);
    let rows = queue["items"].as_array().unwrap();
    assert!(rows.iter().any(|row| row["id"] == good));
    let bad_row = rows.iter().find(|row| row["id"] == bad).unwrap();
    assert!(
        bad_row["attention"]["reasons"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["code"] == "unsupported_conversion" && r["blocker"]["path"] == "auth.rs")
    );
    let recorded = f.run(
        "a",
        &[
            "maintenance",
            &bad,
            "--source",
            "auth.rs",
            "--view",
            "recorded",
        ],
    );
    assert!(recorded.to_string().contains("auth_service"));
    assert!(
        !f.output(
            "a",
            &[
                "learn",
                "blocked",
                "--evidence",
                "auth.rs",
                "--actor",
                "fixture"
            ]
        )
        .status
        .success()
    );
    assert_eq!(before, journal_bytes(&f, "a"));

    // A helper on an unrelated tracked path must also remain disabled.
    let marker = f.temp.path().join("helper-executed");
    let script = f.temp.path().join("helper.sh");
    fs::write(
        &script,
        format!("#!/bin/sh\necho executed >> '{}'\ncat\n", marker.display()),
    )
    .unwrap();
    let helper = format!("sh '{}'", script.display());
    git(&root, &["config", "filter.marker.clean", &helper]);
    git(&root, &["config", "filter.marker.smudge", &helper]);
    git(&root, &["config", "filter.marker.process", &helper]);
    git(&root, &["config", "filter.marker.required", "true"]);
    git(&root, &["config", "core.fsmonitor", &helper]);
    git(&root, &["config", "diff.external", &helper]);
    git(&root, &["config", "diff.marker.textconv", &helper]);
    fs::write(
        root.join(".git/info/attributes"),
        "auth.rs filter=marker diff=marker\n",
    )
    .unwrap();
    fs::write(root.join("auth.rs"), "fn rotate() { auth_service(); }\n").unwrap();
    let queue = f.run("a", &["maintenance"]);
    assert!(queue.to_string().contains("safe_cleanliness_unavailable"));
    f.run("a", &["maintenance", &good]);
    f.run(
        "a",
        &["maintenance", &bad, "--source", "auth.rs", "--view", "diff"],
    );
    let selected = f.run("a", &["maintenance", &good]);
    let assessment = f.temp.path().join("assessment.json");
    fs::write(&assessment, serde_json::to_vec(&selected).unwrap()).unwrap();
    assert!(
        !f.output(
            "a",
            &[
                "review-assessed",
                "--assessment",
                assessment.to_str().unwrap(),
                "--reviewed",
                "--actor",
                "fixture"
            ]
        )
        .status
        .success()
    );
    assert!(
        !f.output(
            "a",
            &[
                "learn",
                "unrelated support",
                "--evidence",
                "auth.rs",
                "--actor",
                "fixture"
            ]
        )
        .status
        .success()
    );
    assert!(!marker.exists());
    assert_eq!(before, journal_bytes(&f, "a"));
}

#[test]
fn production_reader_accepts_a_deep_imported_acyclic_chain_without_abort() {
    let f = Fixture::new();
    f.run("a", &["replay"]);
    let revision = f.run("a", &["orient"])["revision"].clone();
    let count = 45_000u128;
    let mut events = Vec::new();
    let mut event_id = count + 1;
    for i in 0..count {
        let id = uuid::Uuid::from_u128(i + 1);
        event_id += 1;
        let payload = serde_json::json!({"type":"Created","claim":{"id":id,"kind":"Discovery","statement":format!("Claim {i}"),"rationale":null,"scope":["auth.rs"],"learned_at":revision,"branch":"main","dirty":false,"provisional":false}});
        let make = |number, payload| serde_json::json!({"version":2,"id":uuid::Uuid::from_u128(number),"repository":"test/identity","actor":{"id":"fixture","kind":"Agent","harness":null,"session":null},"created_at_unix_ms":0,"payload":payload});
        events.push(make(event_id, payload));
        if i > 0 {
            event_id += 1;
            events.push(make(event_id, serde_json::json!({"type":"Superseded","old":uuid::Uuid::from_u128(i),"new":id,"revision":revision})));
        }
    }
    let repository = fs::read_dir(f.temp.path().join("state-a/repositories"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let segment = repository.join("events/deep-chain.json");
    fs::create_dir_all(segment.parent().unwrap()).unwrap();
    let bytes = serde_json::to_vec(&serde_json::json!({"version":2,"events":events})).unwrap();
    fs::write(&segment, &bytes).unwrap();
    let result = f.run("a", &["orient"]);
    assert!(!result["items"].as_array().unwrap().is_empty());
    assert_eq!(fs::read(segment).unwrap(), bytes);
}

#[test]
fn safe_git_does_not_enter_submodule_helpers() {
    let f = Fixture::new();
    let id = f.learn("a", "Root contract", "auth.rs");
    let root = f.root("a");
    git(
        &root,
        &[
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            f.root("b").to_str().unwrap(),
            "nested",
        ],
    );
    commit(&root);
    let nested = root.join("nested");
    let marker = f.temp.path().join("nested-executed");
    let helper = format!("echo executed >> '{}'; cat", marker.display());
    git(&nested, &["config", "filter.nested.clean", &helper]);
    git(&nested, &["config", "core.fsmonitor", &helper]);
    let gitdir = fs::read_to_string(nested.join(".git")).unwrap();
    let gitdir = nested.join(gitdir.trim().strip_prefix("gitdir: ").unwrap());
    fs::create_dir_all(gitdir.join("info")).unwrap();
    fs::write(gitdir.join("info/attributes"), "auth.rs filter=nested\n").unwrap();
    fs::write(nested.join("auth.rs"), "fn rotate() { auth_service(); }\n").unwrap();
    let before = journal_bytes(&f, "a");
    let value = f.run("a", &["maintenance", &id]);
    assert!(value.to_string().contains("safe_cleanliness_unavailable"));
    assert!(!marker.exists());
    assert_eq!(journal_bytes(&f, "a"), before);
}
