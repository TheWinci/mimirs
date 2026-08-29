use std::fs;

use tempfile::TempDir;

use super::*;

#[test]
fn first_init_creates_the_project_files_and_database() {
    let dir = TempDir::new().unwrap();

    run_at(dir.path()).unwrap();

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

    run_at(dir.path()).unwrap();

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

    run_at(dir.path()).unwrap();

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
