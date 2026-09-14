use super::*;

#[test]
fn cli_traverses_long_history_without_growing_current_detail() {
    let f = Fixture::new();
    let id = f.run(
        "a",
        &[
            "learn",
            "complete contract",
            "--evidence",
            "auth.rs",
            "--evidence",
            "retry.rs",
            "--actor",
            "reviewer",
        ],
    )["knowledge_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let claim = f.run("a", &["show", &id, "--history"]);
    let support = claim["history"]["evidence"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["evidence"].clone())
        .collect::<Vec<_>>();
    let mut parent = claim["item"]["review_heads"][0].clone();
    let revision = claim["history"]["claim"]["learned_at"].clone();
    let mut events = Vec::new();
    for _ in 0..1001 {
        let event = serde_json::json!({"version":2,"id":uuid::Uuid::now_v7(),"repository":"test/identity",
            "actor":{"id":"fixture","kind":"Human","harness":null,"session":null},"created_at_unix_ms":1,
            "payload":{"type":"Reviewed","review":{"knowledge":id,"revision":revision,"evidence":support,"replaces":[parent],"promote":true,"branch":"main","default_branch":"main"}}});
        parent = event["id"].clone();
        events.push(event);
    }
    let repository = fs::read_dir(f.temp.path().join("state-a/repositories"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    fs::write(
        repository.join("events/history-fixture.json"),
        serde_json::to_vec(&serde_json::json!({"version":2,"events":events})).unwrap(),
    )
    .unwrap();
    let before = journal_bytes(&f, "a");
    let detail = f.run("a", &["maintenance", &id]);
    assert!(serde_json::to_vec(&detail).unwrap().len() < 16000);
    assert_eq!(detail["item"]["status"], "Verified");
    assert_eq!(detail["history_total"], 1003);
    let mut cursor = detail["next_history_cursor"].clone();
    let mut rows = std::collections::BTreeMap::<String, usize>::new();
    let mut evidence_counts = std::collections::BTreeMap::<String, usize>::new();
    let mut first = true;
    while let Some(token) = cursor.as_str() {
        let page = f.run(
            "a",
            &[
                "maintenance",
                &id,
                "--history-cursor",
                token,
                "--max-bytes",
                if first { "5000" } else { "256000" },
            ],
        );
        first = false;
        for review in page["reviews"].as_array().unwrap() {
            let event = review["event"].as_str().unwrap().to_owned();
            let count = rows.entry(event.clone()).or_default();
            assert_eq!(*count, review["offset"].as_u64().unwrap() as usize);
            *count += review["replaces"].as_array().unwrap().len()
                + review["evidence"].as_array().unwrap().len()
                + review["scope"].as_array().unwrap().len();
            *evidence_counts.entry(event).or_default() +=
                review["evidence"].as_array().unwrap().len();
            if review["complete"] == true {
                assert_eq!(*count, review["total_rows"].as_u64().unwrap() as usize);
            }
        }
        cursor = page["next_history_cursor"].clone();
    }
    assert_eq!(rows.len(), 1003);
    assert!(evidence_counts.values().all(|n| *n == 2));
    assert_eq!(before, journal_bytes(&f, "a"));
}

#[test]
fn unreadable_evidence_isolated_across_overviews_detail_and_task_context() {
    let f = Fixture::new();
    let bad = f.learn("a", "damaged contract", "auth.rs");
    let good = f.learn("a", "healthy contract", "retry.rs");
    f.learn("a", "shared contract", "retry.rs");
    let before = journal_bytes(&f, "a");
    fs::write(f.root("a").join("auth.rs"), [0xff, 0]).unwrap();
    for command in ["orient", "reconcile"] {
        let view = f.run("a", &[command]);
        assert_eq!(view["files_read"], 2);
        assert_eq!(view["items"].as_array().unwrap().len(), 3);
        assert_eq!(item(&view, &good)["status"], "Verified");
        assert_eq!(
            item(&view, &bad)["evidence"][0]["comparison"],
            "Unavailable"
        );
        assert_eq!(
            item(&view, &bad)["evidence"][0]["problem"],
            "not valid UTF-8"
        );
    }
    let detail = f.run("a", &["show", &bad]);
    assert!(detail["item"]["evidence"][0]["current_sha256"].is_string());
    let maintenance = f.run("a", &["maintenance", &bad]);
    assert_eq!(
        maintenance["item"]["evidence"][0]["current_sha256"],
        maintenance["assessment"]["observed"]["auth.rs"]["sha256"]
    );
    let output = Command::new(env!("CARGO_BIN_EXE_mimirs"))
        .args([
            "context",
            "--output",
            "json",
            "contract",
            "--repository",
            "test/identity",
            "--root",
        ])
        .arg(f.root("a"))
        .arg("--state")
        .arg(f.temp.path().join("state-a"))
        .output()
        .unwrap();
    assert!(output.status.success());
    let task: Value = serde_json::from_slice(&output.stdout).unwrap();
    let claims = task["knowledge"]["items"].as_array().unwrap();
    assert_eq!(
        claims.iter().find(|v| v["id"] == good).unwrap()["status"],
        "Verified"
    );
    assert_eq!(
        claims.iter().find(|v| v["id"] == bad).unwrap()["evidence"][0]["comparison"],
        "Unavailable"
    );
    // A directory replacing a file is a deterministic read failure, even as root.
    fs::remove_file(f.root("a").join("auth.rs")).unwrap();
    fs::create_dir(f.root("a").join("auth.rs")).unwrap();
    let failed = f.run("a", &["orient"]);
    assert_eq!(item(&failed, &good)["status"], "Verified");
    assert!(
        item(&failed, &bad)["evidence"][0]["problem"]
            .as_str()
            .unwrap()
            .contains("not a file")
    );
    assert_eq!(
        item(&failed, &bad)["evidence"][0]["comparison"],
        "Unavailable"
    );
    assert_eq!(before, journal_bytes(&f, "a"));
}

fn revision(root: &Path) -> String {
    String::from_utf8(
        Command::new("git")
            .arg("-C")
            .arg(root)
            .args(["rev-parse", "HEAD"])
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap()
    .trim()
    .into()
}

fn import_event(f: &Fixture, instance: &str, event: &Value) {
    let repository = fs::read_dir(f.temp.path().join(format!("state-{instance}/repositories")))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    fs::write(
        repository
            .join("events")
            .join(format!("{}.json", event["id"].as_str().unwrap())),
        serde_json::to_vec(&serde_json::json!({"version":event["version"],"events":[event]}))
            .unwrap(),
    )
    .unwrap();
}

#[test]
fn automatic_git_conversion_does_not_accept_binary_like_byte_edits() {
    let f = Fixture::new();
    fs::write(f.root("a").join(".gitattributes"), "*.rs text=auto\n").unwrap();
    let binary_like = "\u{1}".repeat(100) + "\n";
    fs::write(f.root("a").join("auth.rs"), &binary_like).unwrap();
    commit(&f.root("a"));
    fs::write(
        f.root("a").join("auth.rs"),
        binary_like.replace('\n', "\r\n"),
    )
    .unwrap();
    let id = f.learn("a", "binary-like support", "auth.rs");
    let view = f.run("a", &["show", &id]);
    assert_eq!(view["item"]["knowledge"]["claim"]["dirty"], true);
    assert_eq!(view["item"]["status"], "Provisional");
}

#[test]
fn supersession_rejects_future_causes_and_preserves_invalid_imports() {
    let f = Fixture::new();
    let a = f.learn("a", "old contract", "auth.rs");
    let c1 = revision(&f.root("a"));
    fs::write(
        f.root("a").join("auth.rs"),
        "fn rotate() { new_service(); }\n",
    )
    .unwrap();
    commit(&f.root("a"));
    let b = f.learn("a", "new contract", "auth.rs");
    let c2 = revision(&f.root("a"));
    git(&f.root("a"), &["checkout", "--detach", &c1]);
    let before = journal_bytes(&f, "a");
    assert!(
        !f.output("a", &["supersede", &a, &b, "--actor", "reviewer"])
            .status
            .success()
    );
    assert_eq!(before, journal_bytes(&f, "a"));
    // Import the exact causal inconsistency from the review reproduction.
    let event = serde_json::json!({"version":2,"id":uuid::Uuid::now_v7(),"repository":"test/identity",
        "actor":{"id":"imported","kind":"Human","harness":null,"session":null},"created_at_unix_ms":1,
        "payload":{"type":"Superseded","old":a,"new":b,"revision":{"repository":"test/identity","commit":c1}}});
    import_event(&f, "a", &event);
    f.sync();
    let unavailable = f.run("b", &["orient"]);
    assert_eq!(
        item(&unavailable, &a)["invalid_relationships"][0]["ancestry"],
        "Unavailable"
    );
    git(&f.root("b"), &["fetch", "origin", &c2]);
    git(&f.root("b"), &["checkout", "--detach", &c2]);
    let invalid = f.run("b", &["orient"]);
    assert_eq!(
        item(&invalid, &a)["invalid_relationships"][0]["ancestry"],
        "NotAncestor"
    );
    assert_eq!(item(&invalid, &a)["status"], "NeedsRevalidation");
    let history = f.run("b", &["show", &a, "--history"]);
    assert_eq!(history["history"]["replacements"][0]["event"], event["id"]);
    git(&f.root("a"), &["checkout", "main"]);
    assert_eq!(
        item(&f.run("a", &["orient"]), &a)["status"],
        "NeedsRevalidation"
    );
}

#[test]
fn valid_supersession_is_isolated_from_older_checkouts() {
    let f = Fixture::new();
    let a = f.learn("a", "old contract", "auth.rs");
    let c1 = revision(&f.root("a"));
    fs::write(
        f.root("a").join("auth.rs"),
        "fn rotate() { new_service(); }\n",
    )
    .unwrap();
    commit(&f.root("a"));
    let b = f.learn("a", "new contract", "auth.rs");
    f.run("a", &["supersede", &a, &b, "--actor", "reviewer"]);
    assert_eq!(item(&f.run("a", &["orient"]), &a)["status"], "Superseded");
    git(&f.root("a"), &["checkout", "--detach", &c1]);
    assert_eq!(item(&f.run("a", &["orient"]), &a)["status"], "Verified");
}

#[test]
fn crlf_commit_identity_preserves_exact_observations_and_historical_bytes() {
    let f = Fixture::new();
    fs::write(f.root("a").join(".gitattributes"), "*.rs text eol=crlf\n").unwrap();
    let raw = "fn rotate() {\r\n    auth_service();\r\n}\r\n";
    fs::write(f.root("a").join("auth.rs"), raw).unwrap();
    commit(&f.root("a"));
    let id = f.learn("a", "rotation contract", "auth.rs");
    let detail = f.run("a", &["maintenance", &id]);
    assert_eq!(detail["item"]["status"], "Verified");
    assert_eq!(detail["item"]["knowledge"]["claim"]["dirty"], false);
    let assessment = f.temp.path().join("assessment.json");
    fs::write(&assessment, serde_json::to_vec(&detail).unwrap()).unwrap();
    let recorded = f.run(
        "a",
        &[
            "maintenance",
            &id,
            "--source",
            "auth.rs",
            "--view",
            "recorded",
        ],
    );
    assert_eq!(recorded["text"], raw);
    assert_eq!(recorded["byte_identity"], "exact_observed");
    let canonical = f.run(
        "a",
        &[
            "maintenance",
            &id,
            "--source",
            "auth.rs",
            "--view",
            "canonical",
        ],
    );
    assert_eq!(canonical["text"], raw.replace("\r\n", "\n"));
    assert_eq!(canonical["byte_identity"], "canonical_git_blob");
    let args = [
        "review",
        "--assessment",
        assessment.to_str().unwrap(),
        "--reviewed",
        "--actor",
        "reviewer",
    ];
    // Git considers this representation equivalent, but a prior exact observation must not.
    fs::write(f.root("a").join("auth.rs"), raw.replace("\r\n", "\n")).unwrap();
    let before = journal_bytes(&f, "a");
    let stale = f.output("a", &args);
    assert!(!stale.status.success());
    assert!(String::from_utf8_lossy(&stale.stderr).contains("stale assessment"));
    assert_eq!(before, journal_bytes(&f, "a"));
    fs::write(f.root("a").join("auth.rs"), raw).unwrap();
    assert!(f.output("a", &args).status.success());
    assert_eq!(
        f.run("a", &["maintenance", &id])["item"]["status"],
        "Verified"
    );
    let selector = r#"{"version":1,"kind":"function","name":"rotate","owners":[]}"#;
    let anchor = format!(r#"{{"path":"auth.rs","selector":{selector}}}"#);
    let anchored = f.run(
        "a",
        &[
            "learn",
            "anchored rotation",
            "--anchor",
            &anchor,
            "--actor",
            "reviewer",
        ],
    )["knowledge_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let page = f.run(
        "a",
        &[
            "maintenance",
            &anchored,
            "--source",
            "auth.rs",
            "--selector",
            selector,
            "--view",
            "recorded",
        ],
    );
    assert!(page["unavailable"].is_null());
    assert!(
        page["text"]
            .as_str()
            .unwrap()
            .contains("\r\n    auth_service();")
    );
    f.sync();
    assert!(f.run("b", &["show", &anchored, "--history"])["history"]["evidence"][0]["evidence"]["committed"].is_object());
    fs::write(f.root("a").join(".gitattributes"), "*.rs filter=custom\n").unwrap();
    let unsupported = f.output(
        "a",
        &[
            "learn",
            "filter contract",
            "--evidence",
            "auth.rs",
            "--actor",
            "reviewer",
        ],
    );
    assert!(!unsupported.status.success());
    assert!(
        String::from_utf8_lossy(&unsupported.stderr).contains("unsupported evidence conversion")
    );
}
