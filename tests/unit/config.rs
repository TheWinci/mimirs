use super::*;

#[test]
fn worker_defaults_and_limits_adapt_to_available_cpus() {
    let config = Config::from_toml("include = [\"**/*.rs\"]").unwrap();
    for (available, expected) in [(0, 1), (1, 1), (2, 1), (3, 1), (6, 2), (10, 3), (64, 21)] {
        assert_eq!(config.resolved_embedding_workers(available), expected);
    }
    let explicit = Config::from_toml("include = [\"**/*.rs\"]\nembedding_workers = 5").unwrap();
    assert_eq!(explicit.resolved_embedding_workers(10), 5);
    assert_eq!(explicit.resolved_embedding_workers(2), 2);
    assert_eq!(
        Config::from_toml(&explicit.to_toml().unwrap())
            .unwrap()
            .embedding_workers,
        explicit.embedding_workers
    );
    assert!(
        config
            .to_toml()
            .unwrap()
            .contains("# embedding_workers = 3")
    );
}

#[test]
fn worker_limit_rejects_zero_negative_and_non_integer_values() {
    for value in ["0", "-1", "1.5", "\"auto\"", "true"] {
        let error = Config::from_toml(&format!(
            "include = [\"**/*.rs\"]\nembedding_workers = {value}"
        ))
        .unwrap_err();
        assert!(format!("{error:#}").contains("embedding_workers"));
    }
}

#[test]
fn load_reports_a_missing_file() {
    let err = Config::load(Path::new("/nonexistent-mimirs-root")).unwrap_err();

    assert!(err.to_string().contains("run `mimirs init`"), "{err}");
}

#[test]
fn from_toml_reports_a_parse_error() {
    let err = Config::from_toml("include = 5").unwrap_err();

    assert!(err.to_string().contains("include"), "{err}");
}

#[test]
fn from_toml_rejects_an_empty_include() {
    let err = Config::from_toml("include = []\nexclude = []").unwrap_err();

    assert_eq!(err.to_string(), "`include` is empty, so no file matches");
}

#[test]
fn from_toml_rejects_an_absent_include() {
    let err = Config::from_toml("exclude = []").unwrap_err();

    assert_eq!(err.to_string(), "`include` is empty, so no file matches");
}

#[test]
fn from_toml_accepts_an_absent_exclude() {
    let config = Config::from_toml(r#"include = ["src/**"]"#).unwrap();

    assert!(config.exclude.is_empty());
}

#[test]
fn from_toml_accepts_the_default() {
    let config = Config::from_toml(&Config::default().to_toml().unwrap()).unwrap();

    assert_eq!(
        config.include,
        [
            "**/*.rs", "**/*.py", "**/*.pyi", "**/*.ts", "**/*.mts", "**/*.cts", "**/*.tsx",
            "**/*.js", "**/*.mjs", "**/*.cjs", "**/*.jsx", "**/*.go"
        ]
    );
}

#[test]
fn obsolete_retrieval_keys_have_actionable_guidance() {
    for value in ["\"raw\"", "\"facts\"", "\"source\"", "false"] {
        let text =
            format!("include = [\"src/**\"]\nexclude = [\"private/**\"]\nretrieval = {value}\n");
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join(".mimirs")).unwrap();
        let path = dir.path().join(".mimirs/config.toml");
        std::fs::write(&path, &text).unwrap();
        let error = format!("{:#}", Config::load(dir.path()).unwrap_err());
        assert!(
            error.contains("`retrieval` is obsolete")
                && error.contains("remove this key")
                && error.contains("mimirs index"),
            "{error}"
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), text);
    }
    assert!(!Config::default().to_toml().unwrap().contains("retrieval"));
}
