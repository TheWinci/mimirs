use super::*;
use crate::context::test_support::*;
use std::fs;

#[test]
fn context_knowledge_preference_and_request_override_match_mcp() {
    let mut f = Fixture::new();
    f.learn("Read bytes", None, &["reader.rs"]);
    let mut s = server(&f);
    initialize(&mut s);
    let before = f.journal();
    fs::create_dir_all(f.root.join(".mimirs")).unwrap();
    fs::write(
        f.root.join(".mimirs/config.toml"),
        "[context]\nknowledge = 'off'\n",
    )
    .unwrap();
    assert_eq!(
        value(&call(&mut s, "context", json!({"query":"read bytes"})))["knowledge"]["status"],
        "disabled"
    );
    assert_eq!(
        value(&call(
            &mut s,
            "context",
            json!({"query":"read bytes","knowledge":"auto"})
        ))["knowledge"]["status"],
        "ok"
    );
    assert_eq!(
        value(&call(
            &mut s,
            "context",
            json!({"query":"read bytes","knowledge":"off"})
        ))["knowledge"]["status"],
        "disabled"
    );
    assert_eq!(
        call(
            &mut s,
            "context",
            json!({"query":"read bytes","knowledge":"invalid"})
        )["result"]["isError"],
        true
    );
    assert_eq!(before, f.journal());
}

#[test]
fn invalid_history_keeps_its_frontier_bounded_and_blocks_writes() {
    use crate::knowledge::{evidence, model::*};
    let mut f = Fixture::new();
    let id = f.learn("Reader contract", None, &["reader.rs"]);
    let old = f.checkout().revision;
    let claim = f.store.replay().unwrap().remove(&id).unwrap();
    let parent = crate::knowledge::reviews::active(&f.checkout(), &claim)
        .unwrap()
        .heads[0]
        .event;
    let support =
        evidence::capture_set(&f.checkout(), &[evidence::Spec::file("reader.rs")]).unwrap();
    fs::write(f.root.join("other.rs"), "fn other() {}\n").unwrap();
    commit(&f.root);
    let future = f.checkout().revision;
    git(&f.root, &["checkout", "--detach", &old.commit]);
    let mut parent = parent;
    let mut events = Vec::new();
    for index in 0..1002 {
        let event = Event::new(
            &f.repository,
            &actor(),
            KnowledgeEvent::Reviewed {
                review: Review {
                    knowledge: id,
                    revision: if index == 0 {
                        future.clone()
                    } else {
                        old.clone()
                    },
                    evidence: support.clone(),
                    replaces: [parent].into_iter().collect(),
                    promote: false,
                    branch: "main".into(),
                    default_branch: "main".into(),
                },
            },
        )
        .unwrap();
        parent = event.id;
        events.push(event);
    }
    f.store.append(&events).unwrap();
    let mut s = server(&f);
    initialize(&mut s);
    let detail = value(&call(&mut s, "maintenance", json!({"id":id})));
    assert!(serde_json::to_vec(&detail).unwrap().len() < 16000);
    assert_eq!(detail["item"]["status"], "NeedsRevalidation");
    assert_eq!(detail["item"]["invalid_review_history_count"], 1001);
    assert_eq!(detail["assessment"]["invalid_reviews"], json!([parent]));
    assert_eq!(detail["history_total"], 1004);
    assert!(detail["next_history_cursor"].is_string());
    let before = f.journal();
    assert_eq!(
        call(
            &mut s,
            "review",
            json!({"assessment":detail,"actor":"reviewer","reviewed":true})
        )["result"]["isError"],
        true
    );
    assert_eq!(before, f.journal());
}

#[test]
fn long_review_history_is_bounded_traversable_and_bound_to_assessment() {
    use crate::knowledge::{evidence, model::*};
    let mut f = Fixture::new();
    let id = f.learn("Reader contract", None, &["reader.rs", "retry.rs"]);
    let claim = f.store.replay().unwrap().remove(&id).unwrap();
    let current = crate::knowledge::reviews::active(&f.checkout(), &claim).unwrap();
    let mut parent = current.heads[0].event;
    let support = evidence::capture_set(
        &f.checkout(),
        &[
            evidence::Spec::file("reader.rs"),
            evidence::Spec::file("retry.rs"),
        ],
    )
    .unwrap();
    let revision = f.checkout().revision;
    let mut events = Vec::new();
    for _ in 0..1001 {
        let event = Event::new(
            &f.repository,
            &actor(),
            KnowledgeEvent::Reviewed {
                review: Review {
                    knowledge: id,
                    revision: revision.clone(),
                    evidence: support.clone(),
                    replaces: [parent].into_iter().collect(),
                    promote: true,
                    branch: "main".into(),
                    default_branch: "main".into(),
                },
            },
        )
        .unwrap();
        parent = event.id;
        events.push(event);
    }
    f.store.append(&events).unwrap();
    let before = f.journal();
    let mut s = server(&f);
    initialize(&mut s);
    let detail = value(&call(&mut s, "maintenance", json!({"id":id})));
    assert!(serde_json::to_vec(&detail).unwrap().len() < 16000);
    assert_eq!(detail["item"]["status"], "Verified");
    assert_eq!(detail["item"]["promotion_history_count"], 1001);
    assert_eq!(detail["recorded_support"].as_array().unwrap().len(), 1);
    assert_eq!(
        detail["assessment"]["support_paths"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let first = detail["next_history_cursor"].clone();
    let mut cursor = first.clone();
    let mut seen = std::collections::BTreeSet::new();
    while !cursor.is_null() {
        let page = value(&call(
            &mut s,
            "maintenance",
            json!({"id":id,"history_cursor":cursor,"max_bytes":256000,"assessment":detail["assessment"]}),
        ));
        for review in page["reviews"].as_array().unwrap() {
            if review["complete"] == true {
                seen.insert(review["event"].as_str().unwrap().to_owned());
            }
        }
        cursor = page["next_history_cursor"].clone();
    }
    assert_eq!(seen.len(), 1003);
    assert!(events.iter().all(|e| seen.contains(&e.id.0.to_string())));
    assert_eq!(before, f.journal());
    // Two concurrent current heads remain complete, while old cursors become stale.
    let mut forks = Vec::new();
    for _ in 0..2 {
        let mut event = events.last().unwrap().clone();
        event.id = EventId::new();
        if let KnowledgeEvent::Reviewed { review } = &mut event.payload {
            review.replaces = [parent].into_iter().collect();
        }
        forks.push(event);
    }
    f.store.append(&forks).unwrap();
    assert_eq!(
        call(
            &mut s,
            "maintenance",
            json!({"id":id,"history_cursor":first})
        )["result"]["isError"],
        true
    );
    let conflict = value(&call(&mut s, "maintenance", json!({"id":id})));
    assert_eq!(
        conflict["assessment"]["review_heads"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(conflict["recorded_support"].as_array().unwrap().len(), 2);
    assert_eq!(conflict["item"]["status"], "NeedsRevalidation");
}
fn server(f: &Fixture) -> Server {
    Server {
        options: Options {
            root: f.root.clone(),
            repository: Some(f.repository.0.clone()),
            default_branch: None,
            state: Some(f.state.clone()),
        },
        phase: Phase::New,
        retriever: Retriever::default(),
    }
}
fn initialize(s: &mut Server) {
    let r=s.handle(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2026-07-28","capabilities":{},"clientInfo":{"name":"fixture","version":"1"}}}),unused).unwrap();
    assert_eq!(r["result"]["protocolVersion"], VERSION);
    assert!(
        s.handle(
            json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
            unused
        )
        .is_none()
    );
}
fn call(s: &mut Server, name: &str, args: Value) -> Value {
    s.handle(json!({"jsonrpc":"2.0","id":"call","method":"tools/call","params":{"name":name,"arguments":args}}),unused).unwrap()
}
fn value(response: &Value) -> Value {
    assert_eq!(response["result"]["isError"], false, "{response}");
    serde_json::from_str(response["result"]["content"][0]["text"].as_str().unwrap()).unwrap()
}

#[test]
fn lifecycle_transcript_notifications_errors_and_clean_eof() {
    let f = Fixture::new();
    let mut s = server(&f);
    let lines = [
        json!({"jsonrpc":"2.0","id":0,"method":"tools/list"}),
        json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
        json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":VERSION,"capabilities":{},"clientInfo":{"name":"test","version":"1"}}}),
        json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
        json!({"jsonrpc":"2.0","method":"tools/call","params":{"name":"learn","arguments":{}}}),
        json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}),
        json!({"jsonrpc":"2.0","id":3,"method":"ping"}),
        json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"unknown"}}),
        json!({"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"context","arguments":{"query":3}}}),
        json!({"jsonrpc":"2.0","id":6,"result":{}}),
    ];
    let mut input = lines.iter().map(|v| format!("{v}\n")).collect::<String>();
    input.push_str("{bad}\n");
    let mut output = Vec::new();
    serve(&mut input.as_bytes(), &mut output, &mut s).unwrap();
    let replies: Vec<Value> = String::from_utf8(output)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert_eq!(replies.len(), 7);
    assert_eq!(replies[0]["error"]["code"], -32002);
    assert_eq!(replies[2]["result"]["tools"].as_array().unwrap().len(), 5);
    assert_eq!(replies[4]["error"]["code"], -32602);
    assert_eq!(replies[5]["result"]["isError"], true);
    assert_eq!(replies[6]["error"]["code"], -32700);
    assert!(f.events().is_empty());
}

#[test]
fn maintenance_and_context_match_direct_operations_and_reuse_embedder() {
    let mut f = Fixture::new();
    let id = f.learn("Read bytes", None, &["reader.rs"]);
    f.index(&[("reader.rs", "fn read_bytes() {}\n")]);
    let before = f.journal();
    let mut s = server(&f);
    initialize(&mut s);
    let selected = value(&call(&mut s, "maintenance", json!({"id":id})));
    let direct = crate::context::maintenance::read_request(
        &f.checkout(),
        &f.events(),
        &serde_json::from_value(json!({"id":id})).unwrap(),
    )
    .unwrap();
    assert_eq!(selected, direct);
    let message = json!({"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"context","arguments":{"query":"read bytes"}}});
    let one = value(&s.handle(message.clone(), fixed).unwrap());
    let two = value(&s.handle(message, unused).unwrap());
    assert_eq!(one, two);
    let direct = crate::context::task::execute(
        &crate::context::task::Request {
            output: crate::context::task::Output::Json,
            intent: crate::retrieval::navigation::Intent::Auto,
            root: &f.root,
            query: "read bytes",
            knowledge: None,
            source_limit: 5,
            knowledge_limit: 5,
            max_bytes: 16000,
            repository: Some(&f.repository.0),
            state: Some(&f.state),
            default_branch: None,
        },
        &mut Retriever::default(),
        fixed,
    )
    .unwrap();
    assert_eq!(one, direct);
    assert_eq!(f.journal(), before);
}

#[test]
fn assessed_write_objects_reject_stale_input_and_require_explicit_decisions() {
    let mut f = Fixture::new();
    let id = f.learn("Reader retains bytes", None, &["reader.rs"]);
    let mut s = server(&f);
    initialize(&mut s);
    let selected = value(&call(&mut s, "maintenance", json!({"id":id})));
    let before = f.journal();
    assert_eq!(
        call(
            &mut s,
            "review",
            json!({"assessment":selected,"actor":"reviewer","reviewed":false})
        )["result"]["isError"],
        true
    );
    fs::write(
        f.root.join("reader.rs"),
        "fn read_bytes() { normalize(); }\n",
    )
    .unwrap();
    assert_eq!(
        call(
            &mut s,
            "review",
            json!({"assessment":selected,"actor":"reviewer","reviewed":true})
        )["result"]["isError"],
        true
    );
    assert_eq!(f.journal(), before);
    commit(&f.root);
    let selected = value(&call(&mut s, "maintenance", json!({"id":id})));
    let replaced = value(&call(
        &mut s,
        "replace",
        json!({"assessment":selected["assessment"],"actor":"reviewer","reviewed":true,"statement":"Reader normalizes bytes"}),
    ));
    assert_eq!(replaced["atomic_batch"], true);
    assert_eq!(replaced["superseded"], json!(id));
    let selected = value(&call(
        &mut s,
        "maintenance",
        json!({"id":replaced["knowledge_id"]}),
    ));
    assert_eq!(
        value(&call(
            &mut s,
            "review",
            json!({"assessment":selected,"actor":"reviewer","reviewed":true})
        ))["promotion_requested"],
        false
    );
}

#[test]
fn schemas_reject_unknown_fields_nulls_and_unsupported_evidence_without_writes() {
    let f = Fixture::new();
    let mut s = server(&f);
    initialize(&mut s);
    for (name, args) in [
        (
            "learn",
            json!({"statement":"x","actor":"a","evidence":[{"kind":"symbol","path":"reader.rs"}]}),
        ),
        (
            "learn",
            json!({"statement":"x","actor":"a","evidence":["reader.rs"],"promote":true}),
        ),
        ("context", json!({"query":"x","root":"/tmp"})),
        ("maintenance", json!({"id":null})),
        ("maintenance", json!({"max_bytes":256001})),
    ] {
        assert_eq!(call(&mut s, name, args)["result"]["isError"], true);
    }
    assert!(f.events().is_empty());
    let huge = call(&mut s, "maintenance", json!({"id":"x".repeat(10000)}));
    assert_eq!(huge["result"]["isError"], true);
    assert!(huge["result"]["content"][0]["text"].as_str().unwrap().len() <= 4096);
    let id = value(&call(
        &mut s,
        "learn",
        json!({"statement":"Reader retains bytes","actor":"a","evidence":["reader.rs"]}),
    ))["knowledge_id"]
        .clone();
    assert!(id.is_string());
}

#[test]
fn oversized_input_disconnects_with_one_bounded_protocol_error() {
    let f = Fixture::new();
    let mut s = server(&f);
    let input = vec![b'x'; MAX_INPUT + 20];
    let mut output = Vec::new();
    serve(&mut input.as_slice(), &mut output, &mut s).unwrap();
    assert!(output.len() < 300);
    let reply: Value = serde_json::from_slice(&output).unwrap();
    assert_eq!(reply["error"]["code"], -32600);
}

#[test]
fn anchors_flow_through_all_five_tools_without_degrading_default_support() {
    let f = Fixture::new();
    let mut s = server(&f);
    initialize(&mut s);
    let selector = json!({"version":1,"kind":"function","name":"read_bytes","owners":[]});
    let anchor = json!({"path":"reader.rs","selector":selector});
    let learned = value(&call(
        &mut s,
        "learn",
        json!({"actor":"reviewer","statement":"Reader preserves original bytes","anchors":[anchor],"evidence":["retry.rs"]}),
    ));
    let id = learned["knowledge_id"].clone();
    let selected = value(&call(&mut s, "maintenance", json!({"id":id})));
    assert_eq!(selected["assessment"]["version"], 2);
    let region = value(&call(
        &mut s,
        "maintenance",
        json!({"id":id,"source":"reader.rs","selector":selector,"view":"recorded"}),
    ));
    assert!(region["text"].as_str().unwrap().contains("read_bytes"));
    value(&call(
        &mut s,
        "review",
        json!({"assessment":selected,"actor":"reviewer","reviewed":true}),
    ));
    let selected = value(&call(&mut s, "maintenance", json!({"id":id})));
    assert_eq!(
        selected["assessment"]["support"].as_array().unwrap().len(),
        2
    );
    let replaced = value(&call(
        &mut s,
        "replace",
        json!({"assessment":selected,"actor":"reviewer","reviewed":true,"statement":"Reader preserves original bytes while retry support is unchanged"}),
    ));
    let next = value(&call(
        &mut s,
        "maintenance",
        json!({"id":replaced["knowledge_id"]}),
    ));
    assert!(
        next["assessment"]["support"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["selector"] == selector)
    );
    let context = value(&call(
        &mut s,
        "context",
        json!({"query":"Reader preserves original bytes"}),
    ));
    assert!(
        context["knowledge"]["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["evidence"]
                .as_array()
                .unwrap()
                .iter()
                .any(|e| e["anchor"]["selector"] == selector))
    );
}

#[test]
fn status_review_and_replace_successes_preserve_historical_failures() {
    for operation in ["review", "replace"] {
        let mut f = Fixture::new();
        let a = f.learn("Claim A", None, &["reader.rs"]);
        let b = f.learn("Claim B", None, &["reader.rs"]);
        let mut server = server(&f);
        initialize(&mut server);
        let mut requests = Vec::new();
        for id in [a, b] {
            let selected = value(&call(&mut server, "maintenance", json!({"id":id})));
            let mut args = json!({"assessment":selected,"actor":"reviewer","reviewed":false});
            if operation == "replace" {
                args["statement"] = json!(format!("Replacement {}", id.0));
            }
            assert_eq!(
                call(&mut server, operation, args.clone())["result"]["isError"],
                true
            );
            requests.push(args);
        }
        let read = || {
            serde_json::from_slice::<Value>(&fs::read(f.root.join(".mimirs/status.json")).unwrap())
                .unwrap()
        };
        let before = read();
        let failures = before["failures"].clone();
        assert_eq!(failures.as_array().unwrap().len(), 2);
        assert!(
            failures
                .as_array()
                .unwrap()
                .iter()
                .all(|f| f["claim"].is_string())
        );
        requests[1]["reviewed"] = json!(true);
        value(&call(&mut server, operation, requests[1].clone()));
        assert_eq!(read()["failures"], failures);
        // Refresh the assessment after B's journal write; it is still a retry of A.
        requests[0]["assessment"] = value(&call(&mut server, "maintenance", json!({"id":a})));
        requests[0]["reviewed"] = json!(true);
        value(&call(&mut server, operation, requests[0].clone()));
        assert_eq!(read()["failures"], failures);
    }
}

#[test]
fn status_context_targets_preserve_a_history_across_b_and_a_success() {
    let mut f = Fixture::new();
    f.learn("Reader contract", None, &["reader.rs"]);
    let mut s = server(&f);
    initialize(&mut s);
    let journal = fs::read_dir(
        fs::read_dir(f.state.join("repositories"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path()
            .join("events"),
    )
    .unwrap()
    .next()
    .unwrap()
    .unwrap()
    .path();
    let saved = fs::read(&journal).unwrap();
    fs::write(&journal, "corrupt").unwrap();
    assert_eq!(
        value(&call(&mut s, "context", json!({"query":"reader contract"})))["knowledge"]["status"],
        "unavailable"
    );
    let read = || {
        serde_json::from_slice::<Value>(&fs::read(f.root.join(".mimirs/status.json")).unwrap())
            .unwrap()
    };
    let history = read()["failures"].clone();
    let other = f._temp.path().join("other-state");
    s.options.repository = Some("test/other".into());
    s.options.state = Some(other.clone());
    s.options.default_branch = Some("other-default".into());
    value(&call(
        &mut s,
        "learn",
        json!({"statement":"Other reader contract","evidence":["reader.rs"],"actor":"fixture"}),
    ));
    assert_ne!(
        value(&call(&mut s, "context", json!({"query":"reader contract"})))["knowledge"]["status"],
        "unavailable"
    );
    let observed = read();
    assert_eq!(observed["failures"], history);
    assert_eq!(
        observed["components"]["knowledge"]["target"]["repository"],
        "test/other"
    );
    assert_eq!(
        observed["components"]["knowledge"]["target"]["state"],
        json!(other)
    );
    assert_eq!(
        observed["components"]["knowledge"]["target"]["default_branch"],
        "other-default"
    );
    fs::write(&journal, &saved).unwrap();
    s.options.repository = Some(f.repository.0.clone());
    s.options.state = Some(f.state.clone());
    s.options.default_branch = Some("main".into());
    value(&call(&mut s, "context", json!({"query":"reader contract"})));
    assert_eq!(read()["failures"], history);
    value(&call(
        &mut s,
        "context",
        json!({"query":"reader contract","knowledge":"off"}),
    ));
    assert_eq!(read()["components"]["knowledge"]["status"], "assessed");
    assert_eq!(read()["failures"], history);
    assert_eq!(fs::read(journal).unwrap(), saved);
}
