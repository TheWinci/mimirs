use super::*;

#[test]
fn document_segmentation_matches_ts_on_equivalent_windows() {
    let (_dir, db, reference) = crate::storage::candidates::tests::fixture();
    let mut files = HashMap::new();
    // Equivalent normalized snapshots isolate segmentation from the upcoming
    // extraction/input port. Separate storage tests audit raw CRLF evidence.
    for file in reference["files"].as_array().unwrap() {
        let path = file["path"].as_str().unwrap();
        let source = file["normalizedSource"].as_str().unwrap();
        let mut analysis = crate::analysis::extract(crate::source::SourceFile {
            path: path.into(),
            text: source.into(),
        })
        .unwrap();
        analysis.entities.clear();
        let mut documents = Vec::new();
        let offset = |utf16: usize| {
            source
                .char_indices()
                .map(|(i, _)| i)
                .chain(std::iter::once(source.len()))
                .find(|&byte| source[..byte].encode_utf16().count() == utf16)
                .unwrap()
        };
        let lines = crate::analysis::LineIndex::new(source);
        for window in reference["windows"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|w| w["path"] == file["path"])
        {
            let id = window["id"].as_u64().unwrap() as usize;
            let owner = window["sourceChunkId"].as_u64().unwrap() as usize;
            let chunk = &window["sourceChunk"];
            let span = lines.span(
                offset(window["startOffset"].as_u64().unwrap() as usize),
                offset(window["endOffset"].as_u64().unwrap() as usize),
            );
            while analysis.entities.len() <= owner {
                analysis.entities.push(crate::analysis::Entity {
                    kind: "fixture".into(),
                    name: None,
                    span: span.clone(),
                    parent: None,
                });
            }
            analysis.entities[owner] = crate::analysis::Entity {
                kind: chunk["kind"].as_str().unwrap().into(),
                name: chunk["name"].as_str().map(str::to_owned),
                span: lines.span(
                    offset(chunk["startOffset"].as_u64().unwrap() as usize),
                    offset(chunk["endOffset"].as_u64().unwrap() as usize),
                ),
                parent: None,
            };
            let document = Document {
                owner: Some(owner),
                part: 0,
                text: window["text"].as_str().unwrap().into(),
                evidence: vec![Evidence {
                    record: crate::retrieval::Record::Source,
                    span,
                }],
            };
            documents.resize(id + 1, document.clone());
            documents[id] = document;
        }
        files.insert(
            path.to_owned(),
            Snapshot {
                analysis,
                documents,
            },
        );
    }
    let mut snapshots = Snapshots {
        db: &db,
        policy: "fixture",
        files,
    };
    for case in reference["nativeCases"].as_array().unwrap() {
        let mut candidates = candidates_from_reference(&case["completed"]);
        // Database ids in the fixture are stable. Get the actual file ids,
        // rather than treating a source chunk id as a file id.
        for candidate in &mut candidates {
            candidate.file_id = db
                .query_row(
                    "SELECT id FROM files WHERE path=?1",
                    [&candidate.path],
                    |r| r.get(0),
                )
                .unwrap();
        }
        let signals = ranking::Signals::read(
            &db,
            case["request"]["query"].as_str().unwrap(),
            &candidates,
            &["generated/**".into()],
        )
        .unwrap();
        let hits =
            ranking::collapse_files(ranking::group_chunks(candidates, |hit| signals.apply(hit)));
        let (mut source, docs, mut relations) = references::segment(&mut snapshots, hits).unwrap();
        source.truncate(5);
        relations.retain(|r| {
            source
                .iter()
                .any(|s| s.representative.path == r.source_path)
        });
        for (actual, key) in [(&source, "source"), (&docs, "docs")] {
            let expected = case["segmented"][key].as_array().unwrap();
            assert_eq!(actual.len(), expected.len(), "{} {key}", case["request"]);
            for (hit, expected) in actual.iter().zip(expected) {
                assert_eq!(
                    hit.representative.id,
                    expected["windowId"].as_i64().unwrap(),
                    "{} {key}",
                    case["request"]
                );
                assert!((hit.score - expected["score"].as_f64().unwrap()).abs() < 1e-12);
                assert_eq!(
                    hit.windows.iter().map(|w| w.id).collect::<Vec<_>>(),
                    expected["windows"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|w| w["id"].as_i64().unwrap())
                        .collect::<Vec<_>>()
                );
                assert_eq!(
                    snapshots.result(hit.clone()).unwrap().preview,
                    expected["preview"].as_str().unwrap()
                );
            }
        }
        assert_eq!(
            relations.len(),
            case["segmented"]["relations"].as_array().unwrap().len()
        );
        for (actual, expected) in relations
            .iter()
            .zip(case["segmented"]["relations"].as_array().unwrap())
        {
            assert_eq!(
                actual.document_window_id,
                expected["documentWindowId"].as_i64().unwrap()
            );
            assert_eq!(
                actual.source_window_id,
                expected["sourceWindowId"].as_i64().unwrap()
            );
            assert_eq!(actual.reference, expected["reference"].as_str().unwrap());
            assert!(
                (actual.inherited_score - expected["inheritedScore"].as_f64().unwrap()).abs()
                    < 1e-12
            );
        }
    }
}

fn candidates_from_reference(completed: &serde_json::Value) -> Vec<Candidate> {
    let mut candidates = std::collections::BTreeMap::new();
    for channel in ["semantic", "lexical"] {
        for (rank, c) in completed[channel].as_array().unwrap().iter().enumerate() {
            let id = c["id"].as_i64().unwrap();
            let candidate = candidates.entry(id).or_insert_with(|| Candidate {
                id,
                file_id: 0,
                ordinal: id as usize,
                owner: Some(c["sourceChunk"]["id"].as_u64().unwrap() as usize),
                path: c["path"].as_str().unwrap().into(),
                start: c["startOffset"].as_u64().unwrap() as usize,
                end: c["endOffset"].as_u64().unwrap() as usize,
                semantic_score: c["semanticScore"].as_f64(),
                lexical_score: c["lexicalScore"].as_f64(),
                semantic_rank: None,
                lexical_rank: None,
            });
            if channel == "semantic" {
                candidate.semantic_rank = Some(rank + 1);
            } else {
                candidate.lexical_rank = Some(rank + 1);
            }
        }
    }
    candidates.into_values().collect()
}

#[test]
fn previews_match_ts_codepoint_and_whitespace_rules() {
    let reference: serde_json::Value = serde_json::from_str(include_str!(
        "../../../benchmarks/versions/port/reference.json"
    ))
    .unwrap();
    for case in reference["previewCases"].as_array().unwrap() {
        assert_eq!(
            preview(case["text"].as_str().unwrap(), 96),
            case["preview"].as_str().unwrap()
        );
        assert_eq!(
            preview(case["text"].as_str().unwrap(), 5),
            case["short"].as_str().unwrap()
        );
    }
}

#[test]
fn references_only_resolve_indexed_sources_and_preserve_snapshot_evidence() {
    let dir = tempfile::tempdir().unwrap();
    let mut db = crate::storage::open(&dir.path().join("index.db"))
        .unwrap()
        .connection;
    let budget =
        crate::retrieval::split::TokenBudget::new(crate::test_support::tokenizer(512)).unwrap();
    let policy = crate::storage::policy::document_policy(&budget);
    for (path, text, weight) in [
        (
            "docs/usage.md",
            "# Recovery\nRead [implementation](../src/worker.rs).\n",
            1.0,
        ),
        (
            "src/worker.rs",
            "/// Exact café 🧭\r\nfn recoverArchive() { manifest(); }\r\n",
            0.0,
        ),
        ("src/other.rs", "fn unrelated() {}", 0.0),
    ] {
        let analysis = crate::analysis::extract(crate::source::SourceFile {
            path: path.into(),
            text: text.into(),
        })
        .unwrap();
        let docs = crate::retrieval::source::documents(&analysis, &budget).unwrap();
        let mut vector = vec![0.0; crate::embedding::DIMENSION];
        vector[0] = weight;
        vector[1] = 1.0 - weight;
        crate::storage::documents::save(
            &mut db,
            &analysis,
            crate::storage::documents::Batch {
                documents: &docs,
                vectors: &vec![vector; docs.len()],
                policy: &policy,
            },
        )
        .unwrap();
    }
    // All non-document sources can be absent from semantic and lexical pools.
    // The strict documentation link still supplies an indexed source citation.
    let response = search(&db, "Recovery", None, 20, &[], &policy).unwrap();
    assert_eq!(response.docs.len(), 1);
    assert_eq!(response.source.len(), 1);
    assert_eq!(response.source[0].hit.representative.path, "src/worker.rs");
    assert_eq!(response.relations.len(), 1);
    assert_eq!(response.relations[0].reference, "../src/worker.rs");
    assert!((response.source[0].hit.score - response.docs[0].hit.score * 0.6).abs() < 1e-12);
    for result in response.source.iter().chain(&response.docs) {
        let analysis = crate::storage::analysis::load(&db, &result.hit.representative.path)
            .unwrap()
            .unwrap();
        assert_eq!(
            result.snapshot_hash,
            crate::storage::processing::source_hash(&analysis.source.text)
        );
        for block in &result.blocks {
            assert_eq!(
                block.text,
                block
                    .evidence
                    .iter()
                    .map(|e| &analysis.source.text[e.span.start..e.span.end])
                    .collect::<Vec<_>>()
                    .join("\n")
            );
        }
    }
    crate::storage::invalidate(&mut db, "src/worker.rs").unwrap();
    let response = search(&db, "Recovery", None, 20, &[], &policy).unwrap();
    assert!(response.source.is_empty());
    assert!(response.relations.is_empty());
}

#[test]
fn strict_reference_forms_do_not_guess_bare_symbols_or_outside_files() {
    use references::{Kind, Reference, extract};
    assert_eq!(
        extract(
            "`src/worker.rs` [worker](../worker.rs#L2) package.worker.Worker bareSymbol Worker http://example.com"
        ),
        vec![
            Reference {
                value: "src/worker.rs".into(),
                kind: Kind::Path
            },
            Reference {
                value: "../worker.rs".into(),
                kind: Kind::Path
            },
            Reference {
                value: "package.worker.Worker".into(),
                kind: Kind::QualifiedSymbol
            },
        ]
    );
}

#[test]
fn qualified_modules_and_unresolved_reference_caps_follow_ts_policy() {
    let dir = tempfile::tempdir().unwrap();
    let mut db = crate::storage::open(&dir.path().join("db"))
        .unwrap()
        .connection;
    let budget =
        crate::retrieval::split::TokenBudget::new(crate::test_support::tokenizer(512)).unwrap();
    let policy = crate::storage::policy::document_policy(&budget);
    for (path, text) in [
        ("pkg/worker/index.rs", "fn Worker() {}\nfn other() {}\n"),
        ("guide.md", "# Manual\nUse pkg.worker.Worker.\n"),
        (
            "capped.md",
            "# Capped\n`missing/a.rs` `missing/b.rs` `missing/c.rs` pkg.worker.Worker\n",
        ),
    ] {
        let analysis = crate::analysis::extract(crate::source::SourceFile {
            path: path.into(),
            text: text.into(),
        })
        .unwrap();
        let docs = crate::retrieval::source::documents(&analysis, &budget).unwrap();
        crate::storage::documents::save(
            &mut db,
            &analysis,
            crate::storage::documents::Batch {
                documents: &docs,
                vectors: &vec![vec![1.0; crate::embedding::DIMENSION]; docs.len()],
                policy: &policy,
            },
        )
        .unwrap();
    }
    let result = search(&db, "Manual", None, 5, &[], &policy).unwrap();
    assert_eq!(result.relations.len(), 1);
    assert_eq!(result.relations[0].source_path, "pkg/worker/index.rs");
    assert_eq!(result.relations[0].symbol.as_deref(), Some("Worker"));
    assert!(result.relations[0].source_range.is_some());
    let capped = search(&db, "Capped", None, 5, &[], &policy).unwrap();
    assert!(capped.source.is_empty());
    assert!(capped.relations.is_empty());
}

#[test]
fn file_results_retain_every_selected_window_and_distinct_owner() {
    let dir = tempfile::tempdir().unwrap();
    let mut db = crate::storage::open(&dir.path().join("db"))
        .unwrap()
        .connection;
    let budget =
        crate::retrieval::split::TokenBudget::new(crate::test_support::tokenizer(64)).unwrap();
    let policy = crate::storage::policy::document_policy(&budget);
    let source = format!(
        "fn recoverArchive() {{\n{}}}\nfn confirmArchive() {{ recoverArchive(); }}\n",
        "    manifest();\n".repeat(150)
    );
    let analysis = crate::analysis::extract(crate::source::SourceFile {
        path: "worker.rs".into(),
        text: source,
    })
    .unwrap();
    let docs = crate::retrieval::source::documents(&analysis, &budget).unwrap();
    crate::storage::documents::save(
        &mut db,
        &analysis,
        crate::storage::documents::Batch {
            documents: &docs,
            vectors: &vec![vec![1.0; crate::embedding::DIMENSION]; docs.len()],
            policy: &policy,
        },
    )
    .unwrap();
    let response = search(
        &db,
        "manifest Archive",
        Some(&vec![1.0; crate::embedding::DIMENSION]),
        20,
        &[],
        &policy,
    )
    .unwrap();
    assert_eq!(response.source.len(), 1);
    let hit = &response.source[0];
    assert!(hit.blocks.len() > 3);
    assert_eq!(hit.blocks.len(), hit.hit.windows.len());
    let owners: std::collections::HashSet<_> =
        hit.blocks.iter().map(|b| b.document.owner).collect();
    assert!(owners.len() >= 2);
    for block in &hit.blocks {
        assert_eq!(
            block.text,
            block
                .evidence
                .iter()
                .map(|e| &analysis.source.text[e.span.start..e.span.end])
                .collect::<Vec<_>>()
                .join("\n")
        );
    }
}
