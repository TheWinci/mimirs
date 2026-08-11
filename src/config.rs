use serde::{Deserialize, Serialize};

/// The on-disk config for one project, stored at `.mimirs/config.toml`.
#[derive(Debug, Serialize, Deserialize)]
pub struct Config {
    /// Glob patterns for the files to index.
    pub include: Vec<String>,
    /// Glob patterns for the files to skip, applied after `include`.
    pub exclude: Vec<String>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            include: ["**/*"].map(String::from).to_vec(),
            exclude: [
                "**/.git/**",
                "**/node_modules/**",
                "**/target/**",
                "**/dist/**",
                "**/build/**",
                "**/vendor/**",
            ]
            .map(String::from)
            .to_vec(),
        }
    }
}

impl Config {
    /// Render this config as the text of `.mimirs/config.toml`.
    pub fn to_toml(&self) -> anyhow::Result<String> {
        Ok(toml::to_string_pretty(self)?)
    }
}
