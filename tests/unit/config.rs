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

    assert_eq!(config.include, ["**/*.rs"]);
}
