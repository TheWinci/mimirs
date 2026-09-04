use tempfile::TempDir;

use super::*;

fn user_version(connection: &Connection) -> i64 {
    connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap()
}

fn assert_schema_table(connection: &Connection, name: &str) {
    let object_type: String = connection
        .query_row(
            "SELECT type FROM sqlite_schema WHERE name = ?1",
            [name],
            |row| row.get(0),
        )
        .unwrap();

    assert_eq!(object_type, "table", "{name} is not a table");
}

#[test]
fn an_opened_connection_has_bundled_vec0() {
    let dir = TempDir::new().unwrap();
    let connection = open(&dir.path().join("index.db")).unwrap().connection;

    let version: String = connection
        .query_row("SELECT vec_version()", [], |row| row.get(0))
        .unwrap();

    assert_eq!(version, "v0.1.9");
}

#[test]
fn a_new_database_reaches_the_current_schema() {
    let dir = TempDir::new().unwrap();
    let connection = open(&dir.path().join("index.db")).unwrap().connection;

    let reached_version = user_version(&connection);
    assert_eq!(
        reached_version, SCHEMA_VERSION,
        "clean dir does not reach newest schema version: {} reached: {}",
        SCHEMA_VERSION, reached_version
    );

    for table in [
        "files",
        "chunks",
        "windows",
        "index_metadata",
        "window_embeddings",
    ] {
        assert_schema_table(&connection, table);
    }

    let vec_schema: String = connection
        .query_row(
            "SELECT sql
             FROM sqlite_schema
             WHERE name = 'window_embeddings'",
            [],
            |row| row.get(0),
        )
        .unwrap();

    assert!(vec_schema.contains("FLOAT[384]"), "{vec_schema}");
    assert!(
        vec_schema.contains("distance_metric=cosine"),
        "{vec_schema}"
    );
}

#[test]
fn reopening_a_database_preserves_data() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("index.db");

    {
        let connection = open(&path).unwrap().connection;
        connection
            .execute(
                "INSERT INTO index_metadata (key, value) VALUES (?1, ?2)",
                ["model", "test-model"],
            )
            .unwrap();

        let _ = connection.close();
    }

    let connection = open(&path).unwrap().connection;

    let value: String = connection
        .query_row(
            "SELECT value FROM index_metadata WHERE key = ?1",
            ["model"],
            |row| row.get(0),
        )
        .unwrap();

    assert_eq!(value, "test-model");
    assert_eq!(user_version(&connection), SCHEMA_VERSION);
}

#[test]
fn a_future_schema_is_rejected_without_mutation() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("index.db");
    let future_version = SCHEMA_VERSION + 1;

    {
        let connection = Connection::open(&path).unwrap();

        connection
            .execute_batch(
                "CREATE TABLE sentinel (value TEXT NOT NULL);
                 INSERT INTO sentinel VALUES ('untouched');",
            )
            .unwrap();

        connection
            .pragma_update(None, "user_version", future_version)
            .unwrap();
    }

    let error = open(&path).expect_err("a future database schema was accepted");

    let message = format!("{error:#}");

    assert!(
        message.contains(&format!("schema version {future_version}")),
        "{message}"
    );
    assert!(
        message.contains(&format!("supported version {SCHEMA_VERSION}")),
        "{message}"
    );

    let connection = Connection::open(&path).unwrap();

    assert_eq!(user_version(&connection), future_version);

    let value: String = connection
        .query_row("SELECT value FROM sentinel", [], |row| row.get(0))
        .unwrap();

    assert_eq!(value, "untouched");
}

#[test]
fn an_opened_connection_enables_foreign_keys() {
    let dir = TempDir::new().unwrap();
    let connection = open(&dir.path().join("index.db")).unwrap().connection;

    let enabled: bool = connection
        .pragma_query_value(None, "foreign_keys", |row| row.get(0))
        .unwrap();

    assert!(enabled);
}

fn source(path: &str, text: &str) -> crate::source::SourceFile {
    crate::source::SourceFile {
        path: path.into(),
        text: text.into(),
    }
}

fn vector(x: f32, y: f32) -> Vec<f32> {
    let mut vector = vec![0.0; crate::embedding::DIMENSION];
    vector[0] = x;
    vector[1] = y;
    vector
}

fn save_text(connection: &mut Connection, path: &str, text: &str) -> anyhow::Result<()> {
    let source = source(path, text);
    let chunks = crate::chunk::of(&source);
    let windows = crate::window::of(&chunks[0]);
    let vectors = vec![vector(1.0, 0.0); windows.len()];
    save_file(
        connection,
        &source,
        &chunks,
        &windows,
        &vectors,
        crate::embedding::MODEL_NAME,
        crate::embedding::DIMENSION,
    )
}

fn count(connection: &Connection, table: &str) -> i64 {
    connection
        .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .unwrap()
}

// Capture every user row, including vector bytes, to prove failed operations
// preserve values and IDs rather than just row counts.
fn snapshot(connection: &Connection) -> Vec<Vec<Vec<rusqlite::types::Value>>> {
    [
        "files",
        "chunks",
        "windows",
        "index_metadata",
        "window_embeddings",
    ]
    .iter()
    .map(|table| {
        let mut statement = connection
            .prepare(&format!("SELECT * FROM {table} ORDER BY 1"))
            .unwrap();
        let columns = statement.column_count();
        statement
            .query_map([], |row| {
                (0..columns).map(|column| row.get(column)).collect()
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
    })
    .collect()
}

#[test]
fn recognized_v1_is_rebuilt_and_open_reports_each_outcome() {
    register_vec().unwrap();
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("index.db");
    let config = dir.path().join("config.toml");
    fs::write(&config, "custom config").unwrap();
    let connection = Connection::open(&path).unwrap();
    connection.execute_batch(SCHEMA_V1).unwrap();
    connection.execute_batch("PRAGMA user_version = 1; INSERT INTO files VALUES (9, 'old.rs'); INSERT INTO index_metadata VALUES ('old', 'value');").unwrap();
    drop(connection);

    let database = open(&path).unwrap();
    assert_eq!(database.outcome, OpenOutcome::Rebuilt);
    assert_eq!(user_version(&database.connection), 2);
    assert_eq!(count(&database.connection, "files"), 0);
    assert_eq!(count(&database.connection, "index_metadata"), 0);
    assert_eq!(fs::read_to_string(config).unwrap(), "custom config");
    assert_eq!(
        database.outcome.message(Path::new("index.db")),
        "rebuilt index.db for schema version 2"
    );
    drop(database);
    let database = open(&path).unwrap();
    assert_eq!(database.outcome, OpenOutcome::Reused);
    assert_eq!(
        database.outcome.message(Path::new("index.db")),
        "index.db already up to date"
    );
    let new = open(&dir.path().join("new.db")).unwrap();
    assert_eq!(new.outcome, OpenOutcome::Created);
    assert_eq!(new.outcome.message(Path::new("new.db")), "created new.db");
}

#[test]
fn unknown_or_damaged_databases_are_unchanged() {
    register_vec().unwrap();
    for case in [
        "foreign_v1",
        "unversioned",
        "empty",
        "damaged",
        "missing_table",
        "wrong_vec",
        "extra_table",
        "broken_fk",
    ] {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("index.db");
        match case {
            "empty" => fs::write(&path, []).unwrap(),
            "damaged" => fs::write(&path, b"this is not SQLite").unwrap(),
            _ => {
                let connection = Connection::open(&path).unwrap();
                match case {
                    "foreign_v1" => connection
                        .execute_batch("CREATE TABLE sentinel(value); PRAGMA user_version = 1;")
                        .unwrap(),
                    "unversioned" => connection
                        .execute_batch("CREATE TABLE sentinel(value);")
                        .unwrap(),
                    "missing_table" => connection
                        .execute_batch(&format!(
                            "{SCHEMA} PRAGMA user_version = 2; DROP TABLE chunks;"
                        ))
                        .unwrap(),
                    "wrong_vec" => connection
                        .execute_batch(&format!(
                            "{} PRAGMA user_version = 1;",
                            SCHEMA_V1.replace("FLOAT[384]", "FLOAT[8]")
                        ))
                        .unwrap(),
                    "extra_table" => connection
                        .execute_batch(&format!(
                            "{SCHEMA_V1} PRAGMA user_version = 1; CREATE TABLE sentinel(value);"
                        ))
                        .unwrap(),
                    "broken_fk" => {
                        connection
                            .pragma_update(None, "foreign_keys", false)
                            .unwrap();
                        connection.execute_batch(&format!("{SCHEMA_V1} PRAGMA user_version = 1; INSERT INTO windows VALUES (1, 999, 0, 0, 1, 1, 'orphan');")).unwrap();
                    }
                    _ => unreachable!(),
                }
            }
        }
        let before = fs::read(&path).unwrap();
        assert!(open(&path).is_err(), "{case}");
        assert_eq!(fs::read(&path).unwrap(), before, "{case}");
    }
}

#[test]
fn rebuild_refuses_to_leave_a_sqlite_journal_behind() {
    register_vec().unwrap();
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("index.db");
    let connection = Connection::open(&path).unwrap();
    connection
        .execute_batch(&format!("{SCHEMA_V1} PRAGMA user_version = 1;"))
        .unwrap();
    drop(connection);
    let before = fs::read(&path).unwrap();
    let journal = dir.path().join("index.db-journal");
    fs::write(&journal, []).unwrap();
    assert!(format!("{:#}", open(&path).unwrap_err()).contains("sidecar"));
    assert_eq!(fs::read(&path).unwrap(), before);
    assert!(journal.exists());
}

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
        assert_eq!(model, crate::embedding::MODEL_NAME);
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
    save_file(
        &mut connection,
        &source,
        &chunks,
        &windows,
        &vectors,
        crate::embedding::MODEL_NAME,
        384,
    )
    .unwrap();
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
        for (chunks, windows, vectors, model, dimension, cause) in [
            (
                &unrelated_chunks,
                &windows,
                vec![vector(1.0, 0.0)],
                crate::embedding::MODEL_NAME,
                384,
                "source file",
            ),
            (
                &chunks,
                &unrelated_windows,
                vec![vector(1.0, 0.0)],
                crate::embedding::MODEL_NAME,
                384,
                "supplied chunk",
            ),
            (
                &chunks,
                &windows,
                vec![],
                crate::embedding::MODEL_NAME,
                384,
                "vectors",
            ),
            (
                &chunks,
                &windows,
                vec![vector(1.0, 0.0); 2],
                crate::embedding::MODEL_NAME,
                384,
                "vectors",
            ),
            (
                &chunks,
                &windows,
                vec![vec![1.0; 383]],
                crate::embedding::MODEL_NAME,
                384,
                "dimension",
            ),
            (
                &chunks,
                &windows,
                vec![vector(f32::NAN, 0.0)],
                crate::embedding::MODEL_NAME,
                384,
                "non-finite",
            ),
            (
                &chunks,
                &windows,
                vec![vector(f32::INFINITY, 0.0)],
                crate::embedding::MODEL_NAME,
                384,
                "non-finite",
            ),
            (
                &chunks,
                &windows,
                vec![vector(f32::NEG_INFINITY, 0.0)],
                crate::embedding::MODEL_NAME,
                384,
                "non-finite",
            ),
            (
                &chunks,
                &windows,
                vec![vector(1.0, 0.0)],
                "other-model",
                384,
                "unsupported",
            ),
            (
                &chunks,
                &windows,
                vec![vector(1.0, 0.0)],
                crate::embedding::MODEL_NAME,
                12,
                "unsupported",
            ),
        ] {
            let error = save_file(
                &mut connection,
                &source,
                chunks,
                windows,
                &vectors,
                model,
                dimension,
            )
            .unwrap_err();
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

fn vector_bytes(vector: &[f32]) -> Vec<u8> {
    vector
        .iter()
        .flat_map(|value| value.to_ne_bytes())
        .collect()
}

#[test]
fn vec0_ranking_matches_scalar_cosine() {
    let dir = TempDir::new().unwrap();
    let mut connection = open(&dir.path().join("index.db")).unwrap().connection;
    let source = source("a.rs", "near\nfar\nmiddle\nopposite");
    let chunks = crate::chunk::of(&source);
    let windows = crate::window::of(&chunks[0]);
    let vectors = vec![
        vector(1.0, 0.0),
        vector(-1.0, 1.0),
        vector(1.0, 1.0),
        vector(-1.0, 0.0),
    ];
    save_file(
        &mut connection,
        &source,
        &chunks,
        &windows,
        &vectors,
        crate::embedding::MODEL_NAME,
        384,
    )
    .unwrap();
    let query = vector(1.0, 0.0);
    let mut expected: Vec<_> = vectors
        .iter()
        .enumerate()
        .map(|(i, v)| {
            (
                i as i64,
                crate::embedding::cosine_similarity(&query, v).unwrap(),
            )
        })
        .collect();
    expected.sort_by(|a, b| b.1.total_cmp(&a.1));
    let mut statement = connection.prepare("SELECT w.ordinal, 1.0 - e.distance FROM window_embeddings e JOIN windows w ON w.id = e.window_id WHERE e.embedding MATCH ?1 AND k = 10 ORDER BY e.distance").unwrap();
    let actual: Vec<(i64, f32)> = statement
        .query_map([vector_bytes(&query)], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(actual.len(), expected.len());
    for (actual, expected) in actual.iter().zip(&expected) {
        assert_eq!(actual.0, expected.0);
        assert!(
            (actual.1 - expected.1).abs() < 1e-6,
            "{actual:?} vs {expected:?}"
        );
    }
}

#[test]
fn only_vec0_stores_vectors_and_windows_have_only_chunk_locations() {
    let dir = TempDir::new().unwrap();
    let connection = open(&dir.path().join("index.db")).unwrap().connection;
    let columns = |table: &str| -> Vec<String> {
        connection
            .prepare(&format!("PRAGMA table_info({table})"))
            .unwrap()
            .query_map([], |row| row.get(1))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    };
    assert_eq!(columns("files"), ["id", "path"]);
    assert_eq!(
        columns("chunks"),
        [
            "id",
            "file_id",
            "ordinal",
            "text",
            "byte_start",
            "byte_end",
            "line_start",
            "line_end"
        ]
    );
    assert_eq!(columns("windows"), ["id", "chunk_id", "ordinal", "text"]);
    assert_eq!(columns("index_metadata"), ["key", "value"]);
    assert!(columns("window_embeddings").contains(&"embedding".into()));
}
