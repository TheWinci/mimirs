use super::*;

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

    assert_eq!(config.include, ["**/*.rs", "**/*.py", "**/*.pyi"]);
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
