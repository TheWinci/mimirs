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
            include: ["**/*.rs", "**/*.py", "**/*.pyi"]
                .map(String::from)
                .to_vec(),
            exclude: [
                "**/.git/**",
                "**/.mimirs/**",
                "**/node_modules/**",
                "**/target/**",
                "**/dist/**",
                "**/build/**",
                "**/vendor/**",
                "**/.venv/**",
                "**/venv/**",
                "**/__pycache__/**",
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
        let value: toml::Value = toml::from_str(text)?;
        if value.get("retrieval").is_some() {
            bail!(
                "`retrieval` is obsolete; remove this key from .mimirs/config.toml, keep include/exclude, and run `mimirs index` to rebuild using source chunks"
            );
        }
        let config: Self = value.try_into()?;

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
#[path = "../tests/unit/config.rs"]
mod tests;
