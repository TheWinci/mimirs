//! Additional formats recognized by v1, without claiming native syntax parsing.
use std::path::Path;

pub const EXTENSIONS: &[&str] = &[
    "md",
    "mdx",
    "markdown",
    "txt",
    "swift",
    "fish",
    "tf",
    "proto",
    "graphql",
    "gql",
    "mod",
    "xml",
    "json",
    "sql",
    "bru",
    "scss",
    "less",
    "zon",
    "zsh",
    "lhs",
    "makefile",
    "dockerfile",
    "jenkinsfile",
    "vagrantfile",
    "gemfile",
    "rakefile",
    "brewfile",
    "procfile",
];

pub const BASENAMES: &[&str] = &[
    "Makefile",
    "GNUmakefile",
    "Vagrantfile",
    "Gemfile",
    "Rakefile",
    "Brewfile",
    "Procfile",
];
pub const PREFIXES: &[&str] = &["Dockerfile", "Jenkinsfile"];

pub fn named_text(path: &str) -> bool {
    let Some(name) = Path::new(path).file_name().and_then(|s| s.to_str()) else {
        return false;
    };
    let lower = name.to_ascii_lowercase();
    BASENAMES.iter().any(|n| n.eq_ignore_ascii_case(name))
        || PREFIXES.iter().any(|n| {
            lower == n.to_ascii_lowercase()
                || lower.starts_with(&format!("{}.", n.to_ascii_lowercase()))
        })
}

pub fn includes() -> Vec<String> {
    let mut patterns: Vec<_> = EXTENSIONS.iter().map(|ext| format!("**/*.{ext}")).collect();
    for name in BASENAMES.iter().chain(PREFIXES) {
        patterns.push(format!("**/{name}"));
        patterns.push(format!("**/{}", name.to_ascii_lowercase()));
    }
    for name in PREFIXES {
        patterns.push(format!("**/{name}.*"));
        patterns.push(format!("**/{}.*", name.to_ascii_lowercase()));
    }
    patterns
}
