use super::*;

fn user_version(connection: &Connection) -> i64 {
    connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap()
}

#[test]
fn search_connection_rejects_writes() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("index.db");
    drop(open(&path).unwrap());
    let connection = open_read_only(&path).unwrap();
    assert!(
        connection
            .execute("INSERT INTO files(path) VALUES ('no.rs')", [])
            .is_err()
    );
    assert_eq!(count(&connection, "files"), 0);
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
    assert_eq!(user_version(&database.connection), SCHEMA_VERSION);
    assert_eq!(count(&database.connection, "files"), 0);
    assert_eq!(count(&database.connection, "index_metadata"), 0);
    assert_eq!(fs::read_to_string(config).unwrap(), "custom config");
    assert_eq!(
        database.outcome.message(Path::new("index.db")),
        format!("rebuilt index.db for schema version {SCHEMA_VERSION}")
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

#[test]
fn pre_revision_schemas_rebuild_only_on_writable_open() {
    for (schema, version) in [(SCHEMA_V5, 5), (SCHEMA_V6, 6)] {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("index.db");
        register_vec().unwrap();
        let db = Connection::open(&path).unwrap();
        db.execute_batch(schema).unwrap();
        db.pragma_update(None, "user_version", version).unwrap();
        drop(db);
        let bytes = std::fs::read(&path).unwrap();
        assert!(open_read_only(&path).is_err());
        assert_eq!(bytes, std::fs::read(&path).unwrap());
        assert_eq!(
            super::super::open(&path).unwrap().outcome,
            OpenOutcome::Rebuilt
        );
    }
}
