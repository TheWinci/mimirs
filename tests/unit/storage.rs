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
fn migrations_are_valid() {
    register_vec().unwrap();

    MIGRATIONS.validate().unwrap();
}

#[test]
fn an_opened_connection_has_bundled_vec0() {
    let dir = TempDir::new().unwrap();
    let connection = open(&dir.path().join("index.db")).unwrap();

    let version: String = connection
        .query_row("SELECT vec_version()", [], |row| row.get(0))
        .unwrap();

    assert_eq!(version, "v0.1.9");
}

#[test]
fn a_new_database_reaches_the_current_schema() {
    let dir = TempDir::new().unwrap();
    let connection = open(&dir.path().join("index.db")).unwrap();

    let reached_version = user_version(&connection);
    assert_eq!(
        reached_version, SCHEMA_VERSION as i64,
        "clean dir does not reach newest schema version: {} reached: {}",
        SCHEMA_VERSION, reached_version
    );

    for table in ["files", "windows", "index_metadata", "window_embeddings"] {
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
        let connection = open(&path).unwrap();
        connection
            .execute(
                "INSERT INTO index_metadata (key, value) VALUES (?1, ?2)",
                ["model", "test-model"],
            )
            .unwrap();

        let _ = connection.close();
    }

    let connection = open(&path).unwrap();

    let value: String = connection
        .query_row(
            "SELECT value FROM index_metadata WHERE key = ?1",
            ["model"],
            |row| row.get(0),
        )
        .unwrap();

    assert_eq!(value, "test-model");
    assert_eq!(user_version(&connection), SCHEMA_VERSION as i64);
}

#[test]
fn a_future_schema_is_rejected_without_mutation() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("index.db");
    let future_version = SCHEMA_VERSION as i64 + 1;

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

    let message = error.to_string();

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
    let connection = open(&dir.path().join("index.db")).unwrap();

    let enabled: bool = connection
        .pragma_query_value(None, "foreign_keys", |row| row.get(0))
        .unwrap();

    assert!(enabled);
}
