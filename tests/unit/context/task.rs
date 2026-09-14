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
        output: Output::Json,
        intent: crate::retrieval::navigation::Intent::Auto,
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

#[test]
fn readable_context_preserves_source_lines_whole_claims_and_budgets() {
    let mut f = Fixture::new();
    let statement = "Read bytes without changing offsets.";
    f.learn(statement, None, &["reader.rs"]);
    f.index(&[(
        "reader.rs",
        "fn read_bytes() {\n    preserve_original();\n}\n",
    )]);
    for budget in [1024, 2048, DEFAULT_BYTES] {
        let mut r = request(&f);
        r.output = Output::Text;
        r.max_bytes = budget;
        let value = execute(&r, &mut Retriever::default(), fixed).unwrap();
        let text = crate::context::text::render(&value, budget);
        assert!(text.len() <= budget);
        if !value["knowledge"]["items"].as_array().unwrap().is_empty() {
            assert!(text.contains(statement));
        }
        if budget == DEFAULT_BYTES {
            assert!(
                text.contains("fn read_bytes() {\n    preserve_original();\n}"),
                "{text}"
            );
            assert!(text.contains("reader.rs:"));
            assert!(!text.contains("navigation_bytes"));
            assert!(!text.contains("evidence: {"));
        }
    }
}

#[test]
fn bounded_adjacency_improves_two_distinct_paths_at_the_same_source_limit() {
    for (primary, neighbor, distractor, query, main, target, noise) in [
        (
            "lib.rs",
            "sink.rs",
            "guide.rs",
            "ingest",
            "mod sink; pub fn ingest() { sink::persist(); }\n",
            "pub fn persist() {}\n",
            "// ingest\npub fn ingest_example() {}\n",
        ),
        (
            "app/main.rs",
            "app/journal.rs",
            "app/a_guide.rs",
            "dispatch",
            "mod journal; pub fn dispatch() { journal::commit(); }\n",
            "pub fn commit() {}\n",
            "// dispatch\npub fn dispatch_example() {}\n",
        ),
    ] {
        let f = Fixture::new();
        fs::remove_file(f.root.join("reader.rs")).unwrap();
        fs::remove_file(f.root.join("retry.rs")).unwrap();
        let files = [(primary, main), (neighbor, target), (distractor, noise)];
        for (path, text) in files {
            fs::create_dir_all(f.root.join(path).parent().unwrap()).unwrap();
            fs::write(f.root.join(path), text).unwrap();
        }
        f.index(&files);
        let mut output = Vec::new();
        let mut progress =
            crate::index::progress::Progress::new(&f.root, &mut output, false, &|| {
                std::time::Duration::ZERO
            });
        let options = crate::knowledge::observation::Options {
            root: f.root.clone(),
            ..Default::default()
        };
        let result = crate::processor::Session::default()
            .process(
                crate::processor::Request {
                    root: &f.root,
                    knowledge: &options,
                    force: true,
                },
                fixed,
                crate::analysis::extract,
                &mut progress,
            )
            .unwrap();
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        let graph = fs::read(f.root.join(".mimirs/watch/relationships.json")).unwrap();
        let mut r = request(&f);
        r.query = query;
        r.source_limit = 2;
        r.knowledge = Some(crate::config::KnowledgeMode::Off);
        r.intent = crate::retrieval::navigation::Intent::Task;
        struct CountQueries(std::sync::Arc<std::sync::atomic::AtomicUsize>);
        impl crate::embedding::Backend for CountQueries {
            fn tokenizer(&mut self) -> anyhow::Result<tokenizers::Tokenizer> {
                Ok(crate::test_support::tokenizer(512))
            }
            fn embed(&mut self, texts: &[String]) -> anyhow::Result<Vec<Vec<f32>>> {
                self.0
                    .fetch_add(texts.len(), std::sync::atomic::Ordering::Relaxed);
                Ok(vec![vector(); texts.len()])
            }
        }
        let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let mut retriever = Retriever::default();
        let task = execute(&r, &mut retriever, || {
            Ok(crate::embedding::Embedder::new(CountQueries(calls.clone())))
        })
        .unwrap();
        r.intent = crate::retrieval::navigation::Intent::Architecture;
        let architecture = execute(&r, &mut retriever, unused).unwrap();
        let paths = |v: &Value| {
            v["source"]["current"]
                .as_array()
                .unwrap()
                .iter()
                .map(|f| f["path"].as_str().unwrap().to_owned())
                .collect::<Vec<_>>()
        };
        assert_eq!(paths(&task)[0], primary, "{task}");
        assert!(
            !paths(&task).contains(&neighbor.to_owned()),
            "baseline already covers path: {task}"
        );
        assert!(
            paths(&architecture).contains(&primary.to_owned()),
            "{architecture}"
        );
        assert!(
            paths(&architecture).contains(&neighbor.to_owned()),
            "{architecture}"
        );
        assert_eq!(paths(&task).len(), paths(&architecture).len());
        assert!(size(&architecture) <= r.max_bytes);
        assert!(
            architecture["navigation"]["candidate_nodes"]
                .as_u64()
                .unwrap()
                <= 12
        );
        assert!(
            architecture["navigation"]["candidate_edges"]
                .as_u64()
                .unwrap()
                <= 16
        );
        assert_eq!(
            graph,
            fs::read(f.root.join(".mimirs/watch/relationships.json")).unwrap()
        );
        let saved: Value = serde_json::from_slice(&graph).unwrap();
        for edge in architecture["navigation"]["edges"].as_array().unwrap() {
            let group = match edge["kind"].as_str().unwrap() {
                "call" => "calls",
                "import" => "imports",
                "reference" => "reExports",
                _ => panic!("invented edge kind"),
            };
            let matched = saved["relationships"][group]
                .as_array()
                .unwrap()
                .iter()
                .any(|fact| {
                    fact["fromPath"] == edge["from"]["path"]
                        && fact["toPath"] == edge["to"]["path"]
                        && if group == "calls" {
                            fact["fact"]["startLine"] == edge["from"]["lines"][0]
                                && fact["fact"]["endLine"] == edge["from"]["lines"][1]
                                && fact["to"]["name"] == edge["to"]["name"]
                                && fact["to"]["startLine"] == edge["to"]["lines"][0]
                        } else {
                            fact["facts"].as_array().unwrap().iter().any(|f| {
                                f["startLine"] == edge["from"]["lines"][0]
                                    && f["endLine"] == edge["from"]["lines"][1]
                            })
                        }
                });
            assert!(matched, "unsupported navigation edge: {edge}");
        }
        for operation in architecture["navigation"]["operations"].as_array().unwrap() {
            let path = operation["path"].as_str().unwrap();
            let bytes = fs::read(f.root.join(path)).unwrap();
            assert_eq!(
                architecture["navigation"]["source_hashes"][path],
                crate::files::fingerprint(&bytes)
            );
            let range = operation["bytes"][0].as_u64().unwrap() as usize
                ..operation["bytes"][1].as_u64().unwrap() as usize;
            assert!(
                std::str::from_utf8(&bytes[range])
                    .unwrap()
                    .contains(operation["name"].as_str().unwrap())
            );
        }
        // Diagnostics cannot authorize or reject graph evidence.
        let status_path = f.root.join(".mimirs/status.json");
        let mut activity = crate::status::Activity::start(&f.root, "fixture", "relationships");
        activity.observe(
            "relationships",
            "verified_stale",
            "historical diagnostic only",
        );
        activity.finish("success", None, None, None);
        let historical = fs::read(&status_path).unwrap();
        for bytes in [None, Some(b"corrupt".to_vec()), Some(historical.clone())] {
            if let Some(bytes) = bytes {
                fs::write(&status_path, bytes).unwrap();
            } else {
                fs::remove_file(&status_path).unwrap();
            }
            let diagnostic_changed = execute(&r, &mut retriever, unused).unwrap();
            assert_eq!(diagnostic_changed["navigation"], architecture["navigation"]);
            assert_eq!(paths(&diagnostic_changed), paths(&architecture));
        }
        let mut mismatched: Value = serde_json::from_slice(&graph).unwrap();
        mismatched["source_hashes"][primary] = Value::String("different saved source".into());
        fs::write(
            f.root.join(".mimirs/watch/relationships.json"),
            serde_json::to_vec(&mismatched).unwrap(),
        )
        .unwrap();
        let mismatch = execute(&r, &mut retriever, unused).unwrap();
        assert_eq!(mismatch["navigation"]["status"], "unavailable");
        assert_eq!(paths(&mismatch), paths(&task));
        fs::write(f.root.join(".mimirs/watch/relationships.json"), &graph).unwrap();
        r.output = Output::Text;
        let readable = execute(&r, &mut retriever, unused).unwrap();
        assert_eq!(readable["navigation"], architecture["navigation"]);
        let text = crate::context::text::render(&readable, DEFAULT_BYTES);
        assert!(text.contains("[resolved call]"), "{text}");
        assert!(text.contains(" imports "), "{text}");
        for line in text.lines().filter(|s| s.contains(" -> ")) {
            assert!(line.ends_with("[resolved call]"), "{line}");
        }
        r.output = Output::Json;
        fs::write(f.root.join(primary), "pub fn changed() {}\n").unwrap();
        let changed = execute(&r, &mut retriever, unused).unwrap();
        assert_eq!(changed["navigation"]["status"], "unavailable");
        assert_eq!(paths(&changed), paths(&task));
        fs::remove_file(f.root.join(".mimirs/watch/relationships.json")).unwrap();
        let missing = execute(&r, &mut retriever, unused).unwrap();
        assert_eq!(missing["navigation"]["status"], "unavailable");
        assert_eq!(paths(&missing), paths(&task));
        assert_eq!(
            calls.load(std::sync::atomic::Ordering::Relaxed),
            9,
            "one embedding per query, none per neighbor"
        );
    }
}

#[test]
fn architecture_intent_is_explicit_or_a_small_deterministic_rule() {
    use crate::retrieval::navigation::Intent;
    assert!(Intent::Auto.architecture("index lifecycle and stages"));
    assert!(!Intent::Auto.architecture("find retry_count"));
    assert!(!Intent::Task.architecture("architecture flow"));
    assert!(Intent::Architecture.architecture("ingest"));
}

#[test]
fn adjacency_caps_cycles_and_reports_unresolved_dispatch_deterministically() {
    let f = Fixture::new();
    fs::remove_file(f.root.join("reader.rs")).unwrap();
    fs::remove_file(f.root.join("retry.rs")).unwrap();
    let mut main = String::new();
    let mut files = Vec::new();
    for n in 0..20 {
        main.push_str(&format!("mod child{n:02};\n"));
        files.push((
            format!("child{n:02}.rs"),
            "pub fn run() { crate::dispatch(); }\n".to_owned(),
        ));
    }
    main.push_str("pub fn dispatch() {\n");
    for n in 0..20 {
        main.push_str(&format!("child{n:02}::run();\n"));
    }
    main.push_str("unknown_callback();\n}\n");
    files.push(("lib.rs".into(), main));
    for (path, text) in &files {
        fs::write(f.root.join(path), text).unwrap();
    }
    f.index(
        &files
            .iter()
            .map(|(p, t)| (p.as_str(), t.as_str()))
            .collect::<Vec<_>>(),
    );
    let mut output = Vec::new();
    let mut progress = crate::index::progress::Progress::new(&f.root, &mut output, false, &|| {
        std::time::Duration::ZERO
    });
    let options = crate::knowledge::observation::Options {
        root: f.root.clone(),
        ..Default::default()
    };
    let result = crate::processor::Session::default()
        .process(
            crate::processor::Request {
                root: &f.root,
                knowledge: &options,
                force: true,
            },
            fixed,
            crate::analysis::extract,
            &mut progress,
        )
        .unwrap();
    assert!(result.errors.is_empty(), "{:?}", result.errors);
    let mut r = request(&f);
    r.query = "dispatch lib flow";
    r.source_limit = 3;
    r.knowledge = Some(crate::config::KnowledgeMode::Off);
    let mut retriever = Retriever::default();
    let first = execute(&r, &mut retriever, fixed).unwrap();
    let second = execute(&r, &mut retriever, unused).unwrap();
    assert_eq!(first, second);
    let nav = &first["navigation"];
    assert!(nav["candidate_nodes"].as_u64().unwrap() <= 12, "{first}");
    assert!(nav["candidate_edges"].as_u64().unwrap() <= 16);
    assert!(nav["omitted_edges"].as_u64().unwrap() > 0, "{first}");
    assert!(nav["unresolved_calls"].as_u64().unwrap() > 0);
    assert!(size(&first) <= DEFAULT_BYTES);
}

#[test]
fn architecture_fallback_retains_source_without_rejected_graph_citations() {
    use crate::retrieval::navigation::Intent;
    for mixed_generation in [false, true] {
        let f = Fixture::new();
        fs::remove_file(f.root.join("reader.rs")).unwrap();
        fs::remove_file(f.root.join("retry.rs")).unwrap();
        let files = [
            ("lib.rs", "mod sink; pub fn ingest() { sink::persist(); }\n"),
            ("guide.rs", "// ingest\npub fn ingest_example() {}\n"),
            ("sink.rs", "pub fn persist() { unknown_callback(); }\n"),
        ];
        for (path, text) in files {
            fs::write(f.root.join(path), text).unwrap();
        }
        f.index(&files);
        let mut output = Vec::new();
        let mut progress =
            crate::index::progress::Progress::new(&f.root, &mut output, false, &|| {
                std::time::Duration::ZERO
            });
        let options = crate::knowledge::observation::Options {
            root: f.root.clone(),
            ..Default::default()
        };
        let published = crate::processor::Session::default()
            .process(
                crate::processor::Request {
                    root: &f.root,
                    knowledge: &options,
                    force: true,
                },
                fixed,
                crate::analysis::extract,
                &mut progress,
            )
            .unwrap();
        assert!(published.errors.is_empty(), "{published:?}");
        let graph_path = f.root.join(".mimirs/watch/relationships.json");
        let graph = fs::read(&graph_path).unwrap();
        let mut r = request(&f);
        r.query = "ingest";
        r.source_limit = 3;
        r.knowledge = Some(crate::config::KnowledgeMode::Off);
        r.intent = Intent::Task;
        let mut retriever = Retriever::default();
        let ranked = execute(&r, &mut retriever, fixed).unwrap();
        let paths = |v: &Value| {
            v["source"]["current"]
                .as_array()
                .unwrap()
                .iter()
                .map(|f| f["path"].as_str().unwrap().to_owned())
                .collect::<Vec<_>>()
        };
        assert_eq!(paths(&ranked), ["lib.rs", "guide.rs", "sink.rs"]);
        r.intent = Intent::Architecture;
        let before = execute(&r, &mut retriever, unused).unwrap();
        assert!(
            before["navigation"]["edges"]
                .as_array()
                .unwrap()
                .iter()
                .any(|edge| edge["kind"] == "call" && edge["to"]["path"] == "sink.rs")
        );
        assert!(before["navigation"]["unresolved_calls"].as_u64().unwrap() > 0);
        let replacement = "// new source generation\npub fn write_record() {}\n";
        if mixed_generation {
            // Refresh actual indexed source/documents while retaining the prior graph.
            // This models mixed generations, not concurrent publication.
            fs::write(f.root.join("sink.rs"), replacement).unwrap();
            f.index(&[("sink.rs", replacement)]);
            assert_eq!(fs::read(&graph_path).unwrap(), graph);
        } else {
            let mut mismatched: Value = serde_json::from_slice(&graph).unwrap();
            mismatched["source_hashes"]["sink.rs"] =
                Value::String("different source binding".into());
            fs::write(&graph_path, serde_json::to_vec(&mismatched).unwrap()).unwrap();
        }
        let result = execute(&r, &mut retriever, unused).unwrap();
        assert_eq!(paths(&result), paths(&ranked), "{result}");
        assert!(size(&result) <= r.max_bytes);
        for file in result["source"]["current"].as_array().unwrap() {
            assert_eq!(file["comparison"], "Unchanged");
        }
        let nav = &result["navigation"];
        assert_eq!(nav["status"], "indexed_unvalidated");
        assert_eq!(nav["selection"][2]["path"], "sink.rs");
        assert_eq!(nav["selection"][2]["reason"], "ranked source fallback");
        assert!(nav["edges"].as_array().unwrap().is_empty(), "{nav}");
        assert!(nav["operations"].as_array().unwrap().is_empty(), "{nav}");
        assert_eq!(nav["unresolved_calls"], 0);
        assert!(nav["source_hashes"].get("sink.rs").is_none());
        assert!(nav["omitted_edges"].as_u64().unwrap() >= 2);
        assert!(!nav["gaps"].as_array().unwrap().iter().any(|gap| {
            let text = gap.as_str().unwrap();
            text.starts_with("sink.rs:") && text.contains("unresolved call")
        }));
        for path in ["lib.rs", "guide.rs"] {
            assert_eq!(
                nav["source_hashes"][path],
                crate::files::fingerprint(&fs::read(f.root.join(path)).unwrap())
            );
        }
        let expected_source = if mixed_generation {
            replacement
        } else {
            files[2].1
        };
        assert!(
            result["source"]["text"]
                .as_str()
                .unwrap()
                .contains(expected_source)
        );
        r.output = Output::Text;
        let readable = execute(&r, &mut retriever, unused).unwrap();
        assert_eq!(readable["navigation"], *nav);
        let text = crate::context::text::render(&readable, r.max_bytes);
        assert!(!text.contains("[resolved call]"));
    }
}
