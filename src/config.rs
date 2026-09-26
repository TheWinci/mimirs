use std::path::Path;

use anyhow::Context;
use serde::{Deserialize, Serialize};

/// The on-disk config for one project, stored at `.mimirs/config.toml`.
#[derive(Debug, Serialize, Deserialize)]
pub struct Config {
    /// Glob patterns for the files to index, relative to the project root.
    pub include: Vec<String>,
    /// Glob patterns for the files to skip, applied after `include`.
    pub exclude: Vec<String>,
}

// The defaults are v1's lists, which its benchmark results were measured with.
const DEFAULT_INCLUDE: &[&str] = &[
    // Source code
    "**/*.ts",
    "**/*.tsx",
    "**/*.js",
    "**/*.jsx",
    "**/*.py",
    "**/*.go",
    "**/*.rs",
    "**/*.java",
    "**/*.c",
    "**/*.h",
    "**/*.cpp",
    "**/*.cc",
    "**/*.cxx",
    "**/*.hpp",
    "**/*.hh",
    "**/*.hxx",
    "**/*.cs",
    "**/*.rb",
    "**/*.php",
    "**/*.scala",
    "**/*.sc",
    "**/*.kt",
    "**/*.kts",
    "**/*.lua",
    "**/*.zig",
    "**/*.zon",
    "**/*.ex",
    "**/*.exs",
    "**/*.hs",
    "**/*.lhs",
    "**/*.ml",
    "**/*.mli",
    "**/*.swift",
    // Markdown and plain text
    "**/*.md",
    "**/*.mdx",
    "**/*.markdown",
    "**/*.txt",
    // Build and task runners
    "**/Makefile",
    "**/makefile",
    "**/GNUmakefile",
    "**/Dockerfile",
    "**/Dockerfile.*",
    "**/Jenkinsfile",
    "**/Jenkinsfile.*",
    "**/Vagrantfile",
    "**/Gemfile",
    "**/Rakefile",
    "**/Brewfile",
    "**/Procfile",
    // Shell scripts
    "**/*.sh",
    "**/*.bash",
    "**/*.zsh",
    "**/*.fish",
    // Structured data and config
    "**/*.yaml",
    "**/*.yml",
    "**/*.toml",
    "**/*.xml",
    // Infrastructure and schema languages
    "**/*.tf",
    "**/*.proto",
    "**/*.graphql",
    "**/*.gql",
    "**/*.sql",
    "**/*.mod",
    // API collections
    "**/*.bru",
    // Stylesheets, JSON, and HTML are left out: they add noise to code search.
];

const DEFAULT_EXCLUDE: &[&str] = &[
    // Package managers and dependencies
    "**/node_modules/**",
    ".yarn/**",
    ".pnp.*",
    // Version control
    ".git/**",
    // Build output and bundled or minified assets
    "dist/**",
    "build/**",
    "out/**",
    ".output/**",
    "*.min.js",
    "*.min.css",
    "*.bundle.js",
    "*.chunk.js",
    // Framework caches and generated files
    ".next/**",
    ".nuxt/**",
    ".svelte-kit/**",
    ".turbo/**",
    // Tool caches
    ".cache/**",
    ".parcel-cache/**",
    ".webpack/**",
    // Test and coverage output
    "coverage/**",
    ".nyc_output/**",
    // Secrets, including nested copies that no ignore file covers
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
    // IDE settings
    ".idea/**",
    ".vscode/**",
    // Python
    "**/__pycache__/**",
    ".venv/**",
    "venv/**",
    ".tox/**",
    "*.egg-info/**",
    // Rust
    "target/**",
    // Go
    "**/vendor/**",
    // The mimirs index
    ".mimirs/**",
];

impl Default for Config {
    fn default() -> Self {
        Self {
            include: DEFAULT_INCLUDE.iter().map(|&glob| glob.into()).collect(),
            exclude: DEFAULT_EXCLUDE.iter().map(|&glob| glob.into()).collect(),
        }
    }
}

impl Config {
    /// Read the config written by `mimirs init`.
    pub fn load(path: &Path) -> anyhow::Result<Self> {
        let text = std::fs::read_to_string(path).with_context(|| {
            format!("Could not read {}; run `mimirs init` first", path.display())
        })?;
        Ok(toml::from_str(&text)?)
    }

    /// Render this config as the text of `.mimirs/config.toml`.
    pub fn to_toml(&self) -> anyhow::Result<String> {
        Ok(toml::to_string_pretty(self)?)
    }
}
