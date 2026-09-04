use std::fs;
use std::io;

use tempfile::TempDir;

use super::*;

#[test]
fn first_init_creates_the_project_files_and_database() {
    let dir = TempDir::new().unwrap();

    run_at_with_model(dir.path(), || Ok(())).unwrap();

    let state = dir.path().join(".mimirs");

    assert_eq!(
        fs::read_to_string(state.join(".gitignore")).unwrap(),
        IGNORE_CONTENTS
    );
    assert_eq!(
        fs::read_to_string(state.join("config.toml")).unwrap(),
        Config::default().to_toml().unwrap()
    );
    assert!(state.join("index.db").is_file());
}

#[test]
fn repeated_init_preserves_config_and_database_data() {
    let dir = TempDir::new().unwrap();
    let state = dir.path().join(".mimirs");
    let config_path = state.join("config.toml");
    let database_path = state.join("index.db");
    let custom_config = "include = [\"**/*.md\"]\nexclude = []\n";

    run_at_with_model(dir.path(), || Ok(())).unwrap();

    fs::write(&config_path, custom_config).unwrap();

    {
        let connection = crate::storage::open(&database_path).unwrap();
        connection
            .execute(
                "INSERT INTO index_metadata (key, value) VALUES (?1, ?2)",
                ["marker", "preserve-me"],
            )
            .unwrap();
    }

    run_at_with_model(dir.path(), || Ok(())).unwrap();

    assert_eq!(fs::read_to_string(config_path).unwrap(), custom_config);

    let connection = crate::storage::open(&database_path).unwrap();
    let marker: String = connection
        .query_row(
            "SELECT value FROM index_metadata WHERE key = ?1",
            ["marker"],
            |row| row.get(0),
        )
        .unwrap();

    assert_eq!(marker, "preserve-me");
}

#[test]
fn init_prepares_the_model_after_project_state() {
    let dir = TempDir::new().unwrap();
    let mut preparations = 0;

    run_at_with_model(dir.path(), || {
        preparations += 1;
        Ok(())
    })
    .unwrap();

    assert_eq!(preparations, 1);
    assert!(dir.path().join(".mimirs/index.db").is_file());
}

#[test]
fn model_preparation_failure_keeps_initialized_project_state_and_its_cause() {
    let dir = TempDir::new().unwrap();

    let error = run_at_with_model(dir.path(), || {
        Err(io::Error::other("model host is unavailable").into())
    })
    .unwrap_err();

    assert!(
        error.to_string().contains("model host is unavailable"),
        "{error:#}"
    );
    let state = dir.path().join(".mimirs");
    assert!(state.join("config.toml").is_file());
    assert!(state.join("index.db").is_file());
}
