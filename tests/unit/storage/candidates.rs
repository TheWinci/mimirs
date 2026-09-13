use super::*;

pub(crate) fn fixture() -> (tempfile::TempDir, Connection, serde_json::Value) {
    let reference: serde_json::Value =
        serde_json::from_str(include_str!("../../../tests/fixtures/port/reference.json")).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let db = crate::storage::open(&dir.path().join("index.db"))
        .unwrap()
        .connection;
    db.pragma_update(None, "foreign_keys", false).unwrap();
    for window in reference["windows"].as_array().unwrap() {
        let id = window["id"].as_i64().unwrap();
        let path = window["path"].as_str().unwrap();
        db.execute(
            "INSERT OR IGNORE INTO files(id, path) VALUES (?1, ?2)",
            params![id, path],
        )
        .unwrap();
        db.execute("INSERT INTO retrieval_documents(id, file_id, ordinal, owner, kind, part, policy, text, content_hash, evidence)
            VALUES (?1, (SELECT id FROM files WHERE path=?2), ?1, ?3, 'entity', 0, 'fixture', ?4, '', ?5)",
            params![id, path, window["sourceChunkId"].as_i64().unwrap(), window["text"].as_str().unwrap(), serde_json::json!([{"span":{"start":window["startOffset"],"end":window["endOffset"]}}]).to_string()]).unwrap();
        let chunk = &window["sourceChunk"];
        db.execute("INSERT OR IGNORE INTO entities(file_id, ordinal, kind, name, byte_start, byte_end, line_start, line_end, parent) VALUES ((SELECT id FROM files WHERE path=?1), ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL)", params![path, window["sourceChunkId"].as_i64().unwrap(), chunk["kind"].as_str().unwrap(), chunk["name"].as_str(), chunk["startOffset"].as_i64().unwrap(),chunk["endOffset"].as_i64().unwrap(),chunk["startLine"].as_i64().unwrap(),chunk["endLine"].as_i64().unwrap()]).unwrap();
        lexical::insert(
            &db,
            id,
            path,
            window["sourceChunk"]["name"].as_str(),
            window["text"].as_str().unwrap(),
        )
        .unwrap();
        if let Some(vector) = window["fixtureVector"].as_array() {
            let mut padded = vec![0.0; crate::embedding::DIMENSION];
            for (i, value) in vector.iter().enumerate() {
                padded[i] = value.as_f64().unwrap() as f32;
            }
            db.execute(
                "INSERT INTO document_embeddings VALUES (?1, ?2)",
                params![id, crate::storage::vector_bytes(&padded)],
            )
            .unwrap();
        }
    }
    (dir, db, reference)
}

#[test]
fn completed_channels_and_fusion_match_ts_reference() {
    let (_dir, db, reference) = fixture();
    let mut query = vec![0.0; crate::embedding::DIMENSION];
    query[0] = 1.0;
    for case in reference["nativeCases"].as_array().unwrap() {
        let request = &case["request"];
        for complete in [false, true] {
            let result = read_with_limits(
                &db,
                request["query"].as_str().unwrap(),
                Some(&query),
                request["limit"].as_u64().unwrap() as usize,
                request["semanticLimit"].as_u64().unwrap() as usize,
                complete,
            )
            .unwrap();
            let expected = &case[if complete { "completed" } else { "baseline" }];
            for semantic in [true, false] {
                let name = if semantic { "semantic" } else { "lexical" };
                let score_name = if semantic {
                    "semanticScore"
                } else {
                    "lexicalScore"
                };
                let expected = expected[name].as_array().unwrap();
                assert_eq!(
                    channel_order(&result.candidates, semantic),
                    expected
                        .iter()
                        .map(|h| h["id"].as_i64().unwrap())
                        .collect::<Vec<_>>(),
                    "{request} {name} complete={complete}"
                );
                for (rank, expected) in expected.iter().enumerate() {
                    let hit = result
                        .candidates
                        .iter()
                        .find(|c| c.id == expected["id"].as_i64().unwrap())
                        .unwrap();
                    let score = if semantic {
                        hit.semantic_score
                    } else {
                        hit.lexical_score
                    }
                    .unwrap();
                    assert_eq!(
                        if semantic {
                            hit.semantic_rank
                        } else {
                            hit.lexical_rank
                        },
                        Some(rank + 1)
                    );
                    let wanted = expected[score_name].as_f64().unwrap();
                    let tolerance = if semantic {
                        1e-6
                    } else {
                        1e-12 + 1e-9 * wanted.abs()
                    };
                    assert!(
                        (score - wanted).abs() <= tolerance,
                        "{request} {name} {score} != {wanted}"
                    );
                }
            }
            let mut union = result.baseline_semantic.clone();
            union.extend(&result.baseline_lexical);
            union.sort();
            union.dedup();
            assert_eq!(
                union,
                result.candidates.iter().map(|c| c.id).collect::<Vec<_>>()
            );
        }
    }
    for case in reference["fusion"].as_array().unwrap() {
        let rank = |key| case[key].as_u64().map(|v| v as usize);
        assert!(
            (fusion(rank("semantic_rank"), rank("lexical_rank")) - case["score"].as_f64().unwrap())
                .abs()
                < 1e-12
        );
    }
}

#[test]
fn lexical_only_search_survives_unavailable_vectors_and_validates_queries() {
    let (_dir, db, _) = fixture();
    let read = read(&db, "lexicalOnly", None).unwrap();
    assert_eq!(read.candidates.len(), read.baseline_lexical.len());
    assert!(read.candidates.iter().all(|c| c.semantic_rank.is_none()));
    assert!(super::read(&db, "!!!", None).unwrap().candidates.is_empty());
    for vector in [
        vec![],
        vec![0.0; crate::embedding::DIMENSION],
        vec![f32::NAN; crate::embedding::DIMENSION],
    ] {
        assert!(super::read(&db, "hello", Some(&vector)).is_err());
    }
    db.execute("DELETE FROM document_embeddings", []).unwrap();
    let mut query = vec![0.0; crate::embedding::DIMENSION];
    query[0] = 1.0;
    assert!(
        !super::read(&db, "lexicalOnly", Some(&query))
            .unwrap()
            .candidates
            .is_empty()
    );
}

#[test]
fn channel_collation_matches_bun_and_final_ties_use_utf16() {
    // Captured with Bun 1.3.14 String.localeCompare, the reference runtime.
    let mut paths = [
        "a.ts",
        "A.ts",
        "a_1.ts",
        "a-1.ts",
        "á.ts",
        "ä.ts",
        "z.ts",
        "𐐀.ts",
        "\u{E000}.ts",
        "a/1.ts",
    ];
    paths.sort_by(|a, b| locale_compare(a, b));
    assert_eq!(
        paths,
        [
            "a_1.ts",
            "a-1.ts",
            "a.ts",
            "A.ts",
            "á.ts",
            "ä.ts",
            "a/1.ts",
            "z.ts",
            "𐐀.ts",
            "\u{E000}.ts"
        ]
    );
    assert_eq!(ordinal_compare("𐐀", "\u{E000}"), Ordering::Less);
    assert_eq!(ordinal_compare("a", "A"), Ordering::Greater);
}

#[test]
fn native_grouping_and_reranking_match_ts_reference() {
    use crate::storage::ranking;
    let (_dir, db, reference) = fixture();
    let mut query = vec![0.0; crate::embedding::DIMENSION];
    query[0] = 1.0;
    for case in reference["nativeCases"].as_array().unwrap() {
        let request = &case["request"];
        let candidates = read_with_limits(
            &db,
            request["query"].as_str().unwrap(),
            Some(&query),
            request["limit"].as_u64().unwrap() as usize,
            request["semanticLimit"].as_u64().unwrap() as usize,
            true,
        )
        .unwrap()
        .candidates;
        let signals = ranking::Signals::read(
            &db,
            request["query"].as_str().unwrap(),
            &candidates,
            &["generated/**".into()],
        )
        .unwrap();
        let mut hits =
            ranking::collapse_files(ranking::group_chunks(candidates, |hit| signals.apply(hit)));
        hits.truncate(5);
        let expected = case["candidates"]["results"].as_array().unwrap();
        assert_eq!(hits.len(), expected.len());
        for (hit, expected) in hits.iter().zip(expected) {
            assert_eq!(
                hit.representative.id,
                expected["windowId"].as_i64().unwrap(),
                "{request}"
            );
            assert!(
                (hit.score - expected["score"].as_f64().unwrap()).abs() < 1e-12,
                "{request}"
            );
            assert_eq!(
                hit.windows.iter().map(|w| w.id).collect::<Vec<_>>(),
                expected["windows"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|w| w["id"].as_i64().unwrap())
                    .collect::<Vec<_>>()
            );
        }
    }
}
