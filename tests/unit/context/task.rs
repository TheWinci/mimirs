use super::*;
use crate::context::test_support::*;
use std::fs;

#[test]
fn knowledge_preference_and_explicit_off_skip_loading_and_reallocate_source() {
    let mut f = Fixture::new();
    f.learn("Read bytes from retry support", None, &["retry.rs"]);
    f.index(&[("reader.rs", "fn read_bytes() {}\n")]);
    let mut retriever = Retriever::default();
    let automatic = execute(&request(&f), &mut retriever, fixed).unwrap();
    assert_eq!(automatic["knowledge"]["status"], "ok");
    let before = f.journal();
    let mut config = crate::config::Config::load(&f.root).unwrap();
    config.context.knowledge = crate::config::KnowledgeMode::Off;
    fs::write(
        f.root.join(".mimirs/config.toml"),
        config.to_toml().unwrap(),
    )
    .unwrap();
    let off = execute(&request(&f), &mut retriever, fixed).unwrap();
    assert_eq!(off["knowledge"]["status"], "disabled");
    assert_eq!(off["live_files_read"], 1);
    assert_eq!(off["source"]["current"], automatic["source"]["current"]);
    assert!(size(&off) <= DEFAULT_BYTES);
    let mut explicit = request(&f);
    explicit.knowledge = Some(crate::config::KnowledgeMode::Auto);
    assert_eq!(
        execute(&explicit, &mut retriever, unused).unwrap()["knowledge"]["status"],
        "ok"
    );
    assert_eq!(before, f.journal());
    // Neither malformed settings nor journal data may be read in off mode.
    fs::create_dir_all(f.root.join(".mimirs/knowledge")).unwrap();
    fs::write(f.root.join(".mimirs/knowledge/settings.toml"), "broken = [").unwrap();
    explicit.knowledge = Some(crate::config::KnowledgeMode::Off);
    assert_eq!(
        execute(&explicit, &mut retriever, unused).unwrap()["knowledge"]["status"],
        "disabled"
    );
    explicit.knowledge = Some(crate::config::KnowledgeMode::Auto);
    let invalid = execute(&explicit, &mut retriever, unused).unwrap();
    assert_eq!(invalid["knowledge"]["status"], "unavailable");
    assert_eq!(invalid["source"]["status"], "ok");
}

fn request(f: &Fixture) -> Request<'_> {
    Request {
        root: &f.root,
        query: "read bytes",
        knowledge: None,
        source_limit: 5,
        knowledge_limit: 5,
        max_bytes: DEFAULT_BYTES,
        repository: Some(&f.repository.0),
        state: Some(&f.state),
        default_branch: Some("main"),
    }
}

#[test]
fn populated_context_reuses_embedder_shared_reads_and_exact_indexed_citations() {
    let mut f = Fixture::new();
    f.learn(
        "Reader retains bytes",
        Some("Original byte offsets are stable"),
        &["reader.rs"],
    );
    let indexed = "fn read_bytes() { preserve_original(); }\n";
    f.index(&[("reader.rs", indexed)]);
    let journal = f.journal();
    let mut retriever = Retriever::default();
    let first = execute(&request(&f), &mut retriever, fixed).unwrap();
    let second = execute(&request(&f), &mut retriever, unused).unwrap();
    assert_eq!(first, second);
    assert!(size(&first) <= DEFAULT_BYTES);
    assert_eq!(first["source"]["status"], "ok");
    assert_eq!(first["knowledge"]["items"][0]["status"], "Verified");
    assert_eq!(first["live_files_read"], 1);
    assert_eq!(first["knowledge"]["evidence_paths"], 1);
    let text = first["source"]["text"].as_str().unwrap();
    assert!(text.contains(indexed));
    let header: Value = serde_json::from_str(
        text.split("\nevidence: ")
            .nth(1)
            .unwrap()
            .split('\n')
            .next()
            .unwrap(),
    )
    .unwrap();
    let a = header["bytes"][0].as_u64().unwrap() as usize;
    let b = header["bytes"][1].as_u64().unwrap() as usize;
    assert_eq!(&indexed[a..b], indexed);
    fs::write(
        f.root.join("reader.rs"),
        "// new prefix\nfn read_bytes() { normalize(); }\n",
    )
    .unwrap();
    let changed = execute(&request(&f), &mut retriever, unused).unwrap();
    assert_eq!(changed["source"]["current"][0]["comparison"], "Modified");
    assert!(
        changed["source"]["text"]
            .as_str()
            .unwrap()
            .contains(indexed)
    );
    assert!(
        !changed["source"]["text"]
            .as_str()
            .unwrap()
            .contains("new prefix")
    );
    assert_eq!(changed["knowledge"]["dirty"], true);
    assert_eq!(
        changed["knowledge"]["items"][0]["status"],
        "NeedsRevalidation"
    );
    assert_eq!(
        changed["knowledge"]["items"][0]["evidence"][0]["comparison"],
        "Modified"
    );
    assert_eq!(f.journal(), journal);
}

#[test]
fn empty_unknown_unconfigured_and_corrupt_knowledge_preserve_source() {
    let f = Fixture::new();
    f.index(&[("reader.rs", "fn read_bytes() {}\n")]);
    let mut retriever = Retriever::default();
    let mut req = request(&f);
    let empty = execute(&req, &mut retriever, fixed).unwrap();
    assert_eq!(empty["knowledge"]["status"], "empty");
    req.repository = None;
    assert_eq!(
        execute(&req, &mut retriever, unused).unwrap()["knowledge"]["status"],
        "not_configured"
    );
    req.repository = Some("unknown/repo");
    let unknown = execute(&req, &mut retriever, unused).unwrap();
    assert_eq!(unknown["knowledge"]["status"], "unavailable");
    assert!(
        unknown["source"]["text"]
            .as_str()
            .unwrap()
            .contains("fn read_bytes")
    );
    req.repository = Some(&f.repository.0);
    let directory = f
        .state
        .join("repositories")
        .join(knowledge::fingerprint(f.repository.0.as_bytes()))
        .join("events");
    fs::create_dir_all(&directory).unwrap();
    fs::write(directory.join("bad.json"), "{").unwrap();
    let corrupt = execute(&req, &mut retriever, unused).unwrap();
    assert_eq!(corrupt["knowledge"]["status"], "unavailable");
    assert_eq!(corrupt["source"]["status"], "ok");
    assert_eq!(fs::read(directory.join("bad.json")).unwrap(), b"{");
    let settings = f.root.join(".mimirs/knowledge/settings.toml");
    fs::create_dir_all(settings.parent().unwrap()).unwrap();
    fs::write(settings, "version = [").unwrap();
    let malformed = execute(&req, &mut retriever, unused).unwrap();
    assert_eq!(malformed["knowledge"]["status"], "unavailable");
    assert_eq!(malformed["source"]["status"], "ok");
    assert!(
        malformed["source"]["text"]
            .as_str()
            .unwrap()
            .contains("fn read_bytes")
    );
}

#[test]
fn failed_and_empty_source_return_useful_knowledge_without_initializing_a_model() {
    let mut f = Fixture::new();
    f.learn("Read bytes without normalization", None, &["reader.rs"]);
    let missing = execute(&request(&f), &mut Retriever::default(), unused).unwrap();
    assert_eq!(missing["source"]["status"], "unavailable");
    assert_eq!(missing["source"]["retrieval"], "failed");
    assert_eq!(missing["knowledge"]["items"].as_array().unwrap().len(), 1);
    f.index(&[]);
    let empty = execute(&request(&f), &mut Retriever::default(), unused).unwrap();
    assert_eq!(empty["source"]["status"], "empty");
    assert_eq!(empty["source"]["retrieval"], "success");
    assert_eq!(empty["knowledge"]["items"].as_array().unwrap().len(), 1);
    f.index(&[("reader.rs", "fn read_bytes() {}\n")]);
    let failed = execute(&request(&f), &mut Retriever::default(), || {
        anyhow::bail!("test query inference failed")
    })
    .unwrap();
    assert_eq!(failed["source"]["retrieval"], "failed");
    assert_eq!(failed["knowledge"]["items"].as_array().unwrap().len(), 1);
}

#[test]
fn escaped_budgets_whole_statements_and_oversized_metadata_are_explicit() {
    let mut f = Fixture::new();
    let statement = format!("Read bytes {}", "😀\"\\\n".repeat(3000));
    let id = f.learn(&statement, None, &["reader.rs"]);
    f.index(&[("reader.rs", "fn read_bytes() { println!(\"café 😀\"); }\n")]);
    let mut retriever = Retriever::default();
    for max_bytes in [1024, 1800, 4000, 16000, 100000] {
        let mut req = request(&f);
        req.max_bytes = max_bytes;
        let result = execute(&req, &mut retriever, fixed).unwrap();
        assert!(
            size(&result) <= max_bytes,
            "{} > {max_bytes}",
            size(&result)
        );
        let items = result["knowledge"]["items"].as_array().unwrap();
        if let Some(item) = items.first() {
            assert_eq!(item["statement"], statement);
        } else {
            assert_eq!(result["knowledge"]["next_detail"], json!(id));
            assert_eq!(result["knowledge"]["omitted_items"], 1);
        }
        if max_bytes >= 4000 {
            assert!(
                result["source"]["text"]
                    .as_str()
                    .unwrap()
                    .contains("fn read_bytes")
            );
        }
    }
    // Index paths may exceed the response budget even when their source is short.
    let huge_path = format!("{}.rs", "p".repeat(17000));
    f.index(&[(&huge_path, "fn read_bytes() {}\n")]);
    let result = execute(&request(&f), &mut retriever, unused).unwrap();
    assert_eq!(result["source"]["status"], "budget_exceeded");
    assert_eq!(result["source"]["retrieval"], "success");
    assert!(size(&result) <= DEFAULT_BYTES);
}

#[test]
fn missing_history_deleted_and_non_utf8_support_are_honest() {
    let mut f = Fixture::new();
    f.learn("Read bytes", None, &["reader.rs"]);
    f.index(&[("reader.rs", "fn read_bytes() {}\n")]);
    let directory = f
        .state
        .join("repositories")
        .join(knowledge::fingerprint(f.repository.0.as_bytes()))
        .join("events");
    let segment = fs::read_dir(directory)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let mut events = f.events();
    replace_revision(&mut events, &"a".repeat(40));
    fs::write(
        &segment,
        serde_json::to_vec(&json!({"version":2,"events":events.values().collect::<Vec<_>>()}))
            .unwrap(),
    )
    .unwrap();
    let mut retriever = Retriever::default();
    let missing = execute(&request(&f), &mut retriever, fixed).unwrap();
    assert_eq!(
        missing["knowledge"]["items"][0]["history"],
        "unavailable_or_not_ancestor"
    );
    assert_ne!(missing["knowledge"]["items"][0]["status"], "Verified");
    fs::remove_file(f.root.join("reader.rs")).unwrap();
    let deleted = execute(&request(&f), &mut retriever, unused).unwrap();
    assert_eq!(deleted["source"]["current"][0]["comparison"], "Missing");
    assert_eq!(
        deleted["knowledge"]["items"][0]["evidence"][0]["comparison"],
        "Missing"
    );
    fs::write(f.root.join("reader.rs"), [0xff, 0xfe]).unwrap();
    let invalid = execute(&request(&f), &mut retriever, unused).unwrap();
    assert_eq!(invalid["source"]["current"][0]["comparison"], "Unavailable");
    let evidence = &invalid["knowledge"]["items"][0]["evidence"][0];
    assert_eq!(evidence["comparison"], "Unavailable");
    assert_eq!(evidence["problem"], "not valid UTF-8");
    assert_eq!(
        evidence["current_sha256"],
        json!(crate::files::fingerprint(&[0xff, 0xfe]))
    );
    assert!(
        invalid["source"]["current"][0]
            .get("indexed_sha256")
            .is_none()
    );
    assert_eq!(invalid["live_files_read"], 1);
}

#[test]
fn empty_source_reallocates_knowledge_budget_and_invalid_requests_do_no_work() {
    let mut f = Fixture::new();
    f.learn(
        &format!("Read bytes {}", "x".repeat(5000)),
        None,
        &["reader.rs"],
    );
    f.index(&[]);
    let result = execute(&request(&f), &mut Retriever::default(), unused).unwrap();
    assert_eq!(result["knowledge"]["items"].as_array().unwrap().len(), 1);
    for max_bytes in [0, 1023] {
        let mut req = request(&f);
        req.max_bytes = max_bytes;
        assert!(execute(&req, &mut Retriever::default(), unused).is_err());
    }
    let long = "x".repeat(4097);
    let mut req = request(&f);
    req.query = &long;
    assert!(execute(&req, &mut Retriever::default(), unused).is_err());
}

#[test]
fn complete_claims_with_shared_support_fit_without_duplicate_fingerprints() {
    let mut f = Fixture::new();
    let paths: Vec<_> = (0..8).map(|n| format!("support{n}.rs")).collect();
    for path in &paths {
        fs::write(f.root.join(path), "fn support() {}\n").unwrap();
    }
    commit(&f.root);
    let refs: Vec<_> = paths.iter().map(String::as_str).collect();
    f.learn("Read bytes preserves originals", None, &refs);
    f.learn("Read bytes uses byte offsets", None, &refs);
    f.index(&[("reader.rs", "fn read_bytes() {}\n")]);
    let value = execute(&request(&f), &mut Retriever::default(), fixed).unwrap();
    let items = value["knowledge"]["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    for item in items {
        let support = item["evidence"].as_array().unwrap();
        assert_eq!(support.len(), 8);
        for edge in support {
            assert_eq!(edge.as_object().unwrap().len(), 2);
            assert_eq!(edge["comparison"], "Unchanged");
        }
    }
    assert_eq!(value["source"]["current"][0].as_object().unwrap().len(), 2);
    assert!(
        value["source"]["text"]
            .as_str()
            .unwrap()
            .contains("snapshot")
    );
    assert!(size(&value) <= DEFAULT_BYTES);
}
