use super::*;

#[test]
fn saves_replace_only_the_requested_file_without_duplicates() {
    let dir = TempDir::new().unwrap();
    let mut connection = open(&dir.path().join("index.db")).unwrap().connection;
    save_text(&mut connection, "a.rs", "first\nsecond").unwrap();
    let original_id: i64 = connection
        .query_row("SELECT id FROM files WHERE path = 'a.rs'", [], |row| {
            row.get(0)
        })
        .unwrap();
    save_text(&mut connection, "b.rs", "unchanged").unwrap();
    let before = snapshot(&connection);
    save_text(&mut connection, "a.rs", "replacement").unwrap();
    save_text(&mut connection, "a.rs", "replacement").unwrap();
    assert_eq!(count(&connection, "files"), 2);
    assert_eq!(count(&connection, "chunks"), 2);
    assert_eq!(count(&connection, "windows"), 2);
    assert_eq!(count(&connection, "window_embeddings"), 2);
    assert_eq!(
        connection
            .query_row("SELECT id FROM files WHERE path = 'a.rs'", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        original_id
    );
    let text: String = connection.query_row("SELECT w.text FROM windows w JOIN chunks c ON c.id = w.chunk_id JOIN files f ON f.id = c.file_id WHERE f.path = 'a.rs'", [], |row| row.get(0)).unwrap();
    assert_eq!(text, "replacement");
    // b.rs owns the last row in the initial snapshot. Its IDs and bytes survive.
    let after = snapshot(&connection);
    for table in [0, 1, 2, 4] {
        assert!(after[table].contains(before[table].last().unwrap()));
    }
    save_text(&mut connection, "a.rs", " \n\t\r\n").unwrap();
    assert_eq!(count(&connection, "files"), 2);
    assert_eq!(count(&connection, "chunks"), 2);
    assert_eq!(count(&connection, "windows"), 1);
    assert_eq!(count(&connection, "window_embeddings"), 1);
    drop(connection);
    let connection = open(&dir.path().join("index.db")).unwrap().connection;
    assert_eq!(count(&connection, "window_embeddings"), 1);
}

#[test]
fn empty_files_store_chunks_and_stamp_the_model() {
    for text in ["", " \n\t\r\n"] {
        let dir = TempDir::new().unwrap();
        let mut connection = open(&dir.path().join("index.db")).unwrap().connection;
        connection
            .execute(
                "INSERT INTO index_metadata VALUES ('marker', 'preserve')",
                [],
            )
            .unwrap();
        save_text(&mut connection, "empty.rs", text).unwrap();
        save_text(&mut connection, "empty.rs", text).unwrap();
        assert_eq!(count(&connection, "files"), 1);
        assert_eq!(count(&connection, "chunks"), 1);
        assert_eq!(count(&connection, "windows"), 0);
        assert_eq!(count(&connection, "window_embeddings"), 0);
        assert_eq!(count(&connection, "index_metadata"), 3);
        let model: String = connection
            .query_row(
                "SELECT value FROM index_metadata WHERE key = 'embedding_model'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let dimension: String = connection
            .query_row(
                "SELECT value FROM index_metadata WHERE key = 'embedding_dimension'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(model, crate::embedding::model_identity());
        assert_eq!(dimension, "384");
        let stored: (String, i64, i64, i64, i64) = connection
            .query_row(
                "SELECT text, byte_start, byte_end, line_start, line_end FROM chunks",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .unwrap();
        let file = source("empty.rs", text);
        let chunks = crate::chunk::of(&file);
        assert_eq!(
            stored,
            (
                text.into(),
                0,
                text.len() as i64,
                1,
                chunks[0].line_end as i64
            )
        );
        // Reconciliation may leave a stamped index with no files.
        connection.execute("DELETE FROM files", []).unwrap();
        save_text(&mut connection, "new.rs", text).unwrap();
    }
}

#[test]
fn equal_chunks_keep_their_identity_and_local_window_order() {
    let dir = TempDir::new().unwrap();
    let mut connection = open(&dir.path().join("index.db")).unwrap().connection;
    let source = source("unicode.rs", "  café();  \r\n\nnext();");
    let chunks = vec![
        crate::chunk::of(&source).remove(0),
        crate::chunk::of(&source).remove(0),
    ];
    let first = crate::window::of(&chunks[0]);
    let second = crate::window::of(&chunks[1]);
    // Interleaving still gives each chunk its own ordinal sequence.
    let windows = [&second[0], &first[0], &second[1], &first[1]]
        .into_iter()
        .map(|window| crate::window::Window {
            chunk: window.chunk,
            text: window.text.clone(),
        })
        .collect::<Vec<_>>();
    let vectors = vec![
        vector(1.0, 0.0),
        vector(0.0, 1.0),
        vector(-1.0, 0.0),
        vector(0.0, -1.0),
    ];
    save_file(&mut connection, &source, &chunks, &windows, &vectors, None).unwrap();
    let mut statement = connection.prepare("SELECT c.ordinal, w.ordinal, w.text, e.embedding FROM windows w JOIN chunks c ON c.id = w.chunk_id JOIN window_embeddings e ON e.window_id = w.id ORDER BY c.ordinal, w.ordinal").unwrap();
    let rows: Vec<(i64, i64, String, Vec<u8>)> = statement
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    for (index, (chunk, ordinal, text, bytes)) in rows.iter().enumerate() {
        assert_eq!((*chunk, *ordinal), ((index / 2) as i64, (index % 2) as i64));
        assert_eq!(text, &first[index % 2].text);
        let vector_index = [1, 3, 0, 2][index];
        assert_eq!(
            *bytes,
            vectors[vector_index]
                .iter()
                .flat_map(|v| v.to_ne_bytes())
                .collect::<Vec<_>>()
        );
    }
}

#[test]
fn invalid_inputs_leave_both_new_and_populated_indexes_unchanged() {
    for populated in [false, true] {
        let dir = TempDir::new().unwrap();
        let mut connection = open(&dir.path().join("index.db")).unwrap().connection;
        if populated {
            save_text(&mut connection, "a.rs", "old").unwrap();
        }
        let before = snapshot(&connection);
        let source = source("a.rs", "new");
        let same_source = crate::source::SourceFile {
            path: source.path.clone(),
            text: source.text.clone(),
        };
        let chunks = crate::chunk::of(&source);
        let equal_chunks = crate::chunk::of(&source);
        let unrelated_chunks = crate::chunk::of(&same_source);
        let windows = crate::window::of(&chunks[0]);
        let unrelated_windows = crate::window::of(&equal_chunks[0]);
        for (chunks, windows, vectors, cause) in [
            (
                &unrelated_chunks,
                &windows,
                vec![vector(1.0, 0.0)],
                "source file",
            ),
            (
                &chunks,
                &unrelated_windows,
                vec![vector(1.0, 0.0)],
                "supplied chunk",
            ),
            (&chunks, &windows, vec![], "vectors"),
            (&chunks, &windows, vec![vector(1.0, 0.0); 2], "vectors"),
            (&chunks, &windows, vec![vec![1.0; 383]], "dimension"),
            (&chunks, &windows, vec![vector(f32::NAN, 0.0)], "non-finite"),
            (
                &chunks,
                &windows,
                vec![vector(f32::INFINITY, 0.0)],
                "non-finite",
            ),
            (
                &chunks,
                &windows,
                vec![vector(f32::NEG_INFINITY, 0.0)],
                "non-finite",
            ),
        ] {
            let error =
                save_file(&mut connection, &source, chunks, windows, &vectors, None).unwrap_err();
            let message = format!("{error:#}");
            assert!(
                message.contains("a.rs") && message.contains(cause),
                "{message}"
            );
            assert_eq!(snapshot(&connection), before);
        }
    }
}

#[test]
fn malformed_metadata_never_overwrites_existing_rows() {
    for mutation in [
        "DELETE FROM index_metadata WHERE key = 'embedding_model'",
        "DELETE FROM index_metadata WHERE key = 'embedding_dimension'",
        "DELETE FROM index_metadata",
        "UPDATE index_metadata SET value = 'other-model' WHERE key = 'embedding_model'",
        "UPDATE index_metadata SET value = '383' WHERE key = 'embedding_dimension'",
        "UPDATE index_metadata SET value = '-384' WHERE key = 'embedding_dimension'",
        "UPDATE index_metadata SET value = 'invalid' WHERE key = 'embedding_dimension'",
    ] {
        let dir = TempDir::new().unwrap();
        let mut connection = open(&dir.path().join("index.db")).unwrap().connection;
        save_text(&mut connection, "a.rs", "old").unwrap();
        connection.execute(mutation, []).unwrap();
        let before = snapshot(&connection);
        assert!(
            save_text(&mut connection, "a.rs", "replacement").is_err(),
            "{mutation}"
        );
        assert_eq!(snapshot(&connection), before, "{mutation}");
    }
    for key in ["embedding_model", "embedding_dimension"] {
        let dir = TempDir::new().unwrap();
        let mut connection = open(&dir.path().join("index.db")).unwrap().connection;
        connection
            .execute("INSERT INTO index_metadata VALUES (?1, 'value')", [key])
            .unwrap();
        let before = snapshot(&connection);
        assert!(save_text(&mut connection, "a.rs", "").is_err());
        assert_eq!(snapshot(&connection), before);
    }
}

#[test]
fn database_failures_roll_back_metadata_deletions_and_partial_inserts() {
    for populated in [false, true] {
        let dir = TempDir::new().unwrap();
        let mut connection = open(&dir.path().join("index.db")).unwrap().connection;
        if populated {
            save_text(&mut connection, "a.rs", "old\ncontent").unwrap();
        }
        let before = snapshot(&connection);
        connection.execute_batch("CREATE TRIGGER fail_window BEFORE INSERT ON windows WHEN NEW.ordinal = 1 BEGIN SELECT RAISE(ABORT, 'forced insert failure'); END;").unwrap();
        let error = save_text(
            &mut connection,
            "a.rs",
            "first insert succeeds\nsecond fails",
        )
        .unwrap_err();
        assert!(format!("{error:#}").contains("forced insert failure"));
        assert_eq!(snapshot(&connection), before);
        if populated {
            let matches: i64 = connection
                .query_row(
                    "SELECT count(*) FROM window_embeddings WHERE embedding MATCH ?1 AND k = 10",
                    [vector_bytes(&vector(1.0, 0.0))],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(matches, 2);
        }
    }
}
