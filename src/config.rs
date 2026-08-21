use std::fs;
use std::io::ErrorKind;
use std::path::Path;

use anyhow::{Context, bail};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub include: Vec<String>,
    /// Applied after `include`.
    #[serde(default)]
    pub exclude: Vec<String>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            include: ["**/*"].map(String::from).to_vec(),
            exclude: [
                "**/.git/**",
                "**/.mimirs/**",
                "**/node_modules/**",
                "**/target/**",
                "**/dist/**",
                "**/build/**",
                "**/vendor/**",
                // Secrets: defence in depth for what git does not ignore.
                "**/.env",
                "**/.env.*",
                "**/*.pem",
                "**/*.key",
                "**/*.pfx",
                "**/*.p12",
                "**/id_rsa",
                "**/id_dsa",
                "**/id_ecdsa",
                "**/id_ed25519",
                "**/.npmrc",
                "**/.pgpass",
                "**/.netrc",
            ]
            .map(String::from)
            .to_vec(),
        }
    }
}

impl Config {
    pub fn load(root: &Path) -> anyhow::Result<Self> {
        let path = root.join(".mimirs").join("config.toml");

        let text = match fs::read_to_string(&path) {
            Ok(text) => text,
            Err(e) if e.kind() == ErrorKind::NotFound => {
                bail!("{} does not exist, run `mimirs init`", path.display())
            }
            Err(e) => return Err(e).with_context(|| format!("cannot read {}", path.display())),
        };

        Self::from_toml(&text).with_context(|| format!("{} is not usable", path.display()))
    }

    fn from_toml(text: &str) -> anyhow::Result<Self> {
        let config: Self = toml::from_str(text)?;

        if config.include.is_empty() {
            bail!("`include` is empty, so no file matches");
        }

        Ok(config)
    }

    pub fn to_toml(&self) -> anyhow::Result<String> {
        Ok(toml::to_string_pretty(self)?)
    }
}

#[cfg(test)]
mod tests {
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

        assert_eq!(config.include, ["**/*"]);
    }
}
