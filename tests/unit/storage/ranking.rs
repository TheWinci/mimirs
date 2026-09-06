use super::*;

fn reference() -> serde_json::Value {
    serde_json::from_str(include_str!(
        "../../../benchmarks/versions/port/reference.json"
    ))
    .unwrap()
}

#[test]
fn chunk_and_file_grouping_match_ts_reference() {
    let reference = reference();
    let fixture = &reference["groupedCases"];
    let rank = |channel: &str, id: i64| {
        fixture[channel]
            .as_array()
            .unwrap()
            .iter()
            .find(|pair| pair[0].as_i64() == Some(id))
            .map(|p| p[1].as_u64().unwrap() as usize)
    };
    let candidates = fixture["candidates"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| {
            let id = c["id"].as_i64().unwrap();
            Candidate {
                id,
                file_id: 1,
                ordinal: id as usize,
                owner: Some(c["sourceChunk"]["id"].as_u64().unwrap() as usize),
                path: c["path"].as_str().unwrap().into(),
                start: c["startOffset"].as_u64().unwrap() as usize,
                end: c["endOffset"].as_u64().unwrap() as usize,
                semantic_score: c["semanticScore"].as_f64(),
                lexical_score: c["lexicalScore"].as_f64(),
                semantic_rank: rank("semanticRanks", id),
                lexical_rank: rank("lexicalRanks", id),
            }
        })
        .collect();
    let chunks = group_chunks(candidates, |_| {});
    for (actual, expected) in chunks.iter().zip(fixture["chunks"].as_array().unwrap()) {
        check_hit(actual, expected);
    }
    let files = collapse_files(chunks);
    assert_eq!(files.len(), fixture["files"].as_array().unwrap().len());
    for (actual, expected) in files.iter().zip(fixture["files"].as_array().unwrap()) {
        check_hit(actual, expected);
    }
}

fn check_hit(actual: &Hit, expected: &serde_json::Value) {
    assert_eq!(
        actual.representative.id,
        expected["windowId"].as_i64().unwrap()
    );
    assert_eq!(
        actual.windows.iter().map(|c| c.id).collect::<Vec<_>>(),
        expected["windows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["id"].as_i64().unwrap())
            .collect::<Vec<_>>()
    );
    for (score, name) in [
        (actual.score, "score"),
        (actual.semantic_score, "semanticScore"),
        (actual.lexical_score, "lexicalScore"),
    ] {
        assert!(
            (score - expected[name].as_f64().unwrap()).abs() < 1e-12,
            "{name}"
        );
    }
}

#[test]
fn signal_identifiers_and_paths_match_ts_reference() {
    let reference = reference();
    for case in reference["signals"]["identifiers"].as_array().unwrap() {
        for (definitions, key) in [(false, "code"), (true, "definitions")] {
            assert_eq!(
                serde_json::json!(identifiers(case["query"].as_str().unwrap(), definitions)),
                case[key]
            );
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let db = crate::storage::open(&dir.path().join("db"))
        .unwrap()
        .connection;
    let signals =
        Signals::read(&db, "", &[], &["generated/**".into(), "**/*.min.js".into()]).unwrap();
    for case in reference["signals"]["paths"].as_array().unwrap() {
        let path = case["path"].as_str().unwrap();
        assert_eq!(is_test(path), case["test"].as_bool().unwrap());
        assert_eq!(
            signals.generated.is_match(normalized_path(path)),
            case["generated"].as_bool().unwrap()
        );
    }
}

#[test]
fn unique_symbol_counts_distinct_files_and_signals_precede_confirmation() {
    let dir = tempfile::tempdir().unwrap();
    let db = crate::storage::open(&dir.path().join("db"))
        .unwrap()
        .connection;
    db.pragma_update(None, "foreign_keys", false).unwrap();
    db.execute_batch(
        "INSERT INTO files VALUES (1,'tests/a.rs'),(2,'b.rs');
        INSERT INTO entities VALUES (1,0,'function','recoverArchive',0,1,1,1,NULL),
            (1,1,'function','recoverArchive',2,3,1,1,NULL),
            (1,2,'function','sameName',4,5,1,1,NULL),
            (2,0,'function','sameName',0,1,1,1,NULL);",
    )
    .unwrap();
    let candidates = (0..3)
        .map(|ordinal| Candidate {
            id: ordinal as i64 + 1,
            file_id: 1,
            ordinal,
            owner: Some(ordinal),
            path: "tests/a.rs".into(),
            start: ordinal * 2,
            end: ordinal * 2 + 1,
            semantic_score: Some(1.0),
            lexical_score: Some(1.0),
            semantic_rank: Some(1),
            lexical_rank: Some(1),
        })
        .collect::<Vec<_>>();
    let signals = Signals::read(&db, "recoverArchive sameName", &candidates, &[]).unwrap();
    assert_eq!(signals.unique.len(), 2);
    let chunks = group_chunks(candidates, |hit| signals.apply(hit));
    assert!((chunks[0].score - 1.2 * 1.3 * 0.85).abs() < 1e-12);
    assert!((chunks[2].score - 1.2 * 0.85).abs() < 1e-12);
    let files = collapse_files(chunks);
    assert!((files[0].score - 1.2 * 1.3 * 0.85 * 1.25).abs() < 1e-12);
    assert_eq!(files[0].windows.len(), 3);
}
