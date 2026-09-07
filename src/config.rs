use std::fs;
use std::io::ErrorKind;
use std::path::Path;

use anyhow::{Context, bail};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct Config {
    /// Generated-source globs receive TS v2's 0.75 ranking multiplier.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub generated: Vec<String>,
    /// Maximum concurrent single-threaded embedding workers. None selects one-third of CPUs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub embedding_workers: Option<std::num::NonZeroUsize>,
    #[serde(default)]
    pub include: Vec<String>,
    /// Applied after `include`.
    #[serde(default)]
    pub exclude: Vec<String>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            embedding_workers: None,
            generated: Vec::new(),
            include: [
                "**/*.ex",
                "**/*.exs",
                "**/*.zig",
                "**/*.lua",
                "**/*.kt",
                "**/*.kts",
                "**/*.css",
                "**/*.html",
                "**/*.htm",
                "**/*.scala",
                "**/*.sc",
                "**/*.php",
                "**/*.rb",
                "**/*.cs",
                "**/*.cpp",
                "**/*.cc",
                "**/*.cxx",
                "**/*.hpp",
                "**/*.hh",
                "**/*.hxx",
                "**/*.c",
                "**/*.h",
                "**/*.rs",
                "**/*.py",
                "**/*.pyi",
                "**/*.ts",
                "**/*.mts",
                "**/*.cts",
                "**/*.tsx",
                "**/*.js",
                "**/*.mjs",
                "**/*.cjs",
                "**/*.jsx",
                "**/*.go",
                "**/*.java",
            ]
            .map(String::from)
            .to_vec(),
            exclude: [
                "**/.git/**",
                "**/.mimirs/**",
                "**/node_modules/**",
                "/target/**",
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
    pub fn resolved_embedding_workers(&self, available: usize) -> usize {
        let available = available.max(1);
        self.embedding_workers
            .map_or((available / 3).max(1), usize::from)
            .min(available)
    }

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
        let mut text = toml::to_string_pretty(self)?;
        if self.embedding_workers.is_none() {
            text.push_str(
                "\n# Omit for one-third of available CPUs, minimum one.\n# embedding_workers = 3\n",
            );
        }
        Ok(text)
    }
}

#[cfg(test)]
#[path = "../tests/unit/config.rs"]
mod tests;
