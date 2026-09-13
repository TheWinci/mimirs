use std::fs;
use std::io::ErrorKind;
use std::path::Path;

use anyhow::{Context, bail};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, clap::ValueEnum)]
#[serde(rename_all = "lowercase")]
pub enum KnowledgeMode {
    #[default]
    Auto,
    Off,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct ContextConfig {
    #[serde(default)]
    pub knowledge: KnowledgeMode,
}
impl ContextConfig {
    fn is_default(&self) -> bool {
        self.knowledge == KnowledgeMode::Auto
    }
}

/// Context preferences work before source initialization. Explicit requests win.
pub fn knowledge_mode(
    root: &Path,
    explicit: Option<KnowledgeMode>,
) -> anyhow::Result<KnowledgeMode> {
    if let Some(mode) = explicit {
        return Ok(mode);
    }
    #[derive(Default, Deserialize)]
    struct Local {
        #[serde(default)]
        context: ContextConfig,
    }
    match fs::read_to_string(root.join(".mimirs/config.toml")) {
        Ok(text) => Ok(toml::from_str::<Local>(&text)
            .context("invalid local context preference")?
            .context
            .knowledge),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(KnowledgeMode::Auto),
        Err(e) => Err(e).context("cannot read local context preference"),
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Config {
    #[serde(default, skip_serializing_if = "ContextConfig::is_default")]
    pub context: ContextConfig,
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
            context: ContextConfig::default(),
            embedding_workers: None,
            generated: Vec::new(),
            include: crate::analysis::language::default_includes(),
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
            .into_iter()
            .map(String::from)
            .collect(),
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
            text.insert_str(
                0,
                "# Omit for one-third of available CPUs, minimum one.\n# embedding_workers = 3\n\n",
            );
        }
        Ok(text)
    }
}

#[cfg(test)]
#[path = "../tests/unit/config.rs"]
mod tests;

impl Config {
    pub(crate) fn selection(&self) -> crate::source::walk::Selection<'_> {
        crate::source::walk::Selection {
            include: &self.include,
            exclude: &self.exclude,
        }
    }
}
