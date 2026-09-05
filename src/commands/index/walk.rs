use std::path::Path;

use ignore::WalkBuilder;
use ignore::overrides::{Override, OverrideBuilder};

use crate::config::Config;

#[derive(Debug, Default, PartialEq)]
pub struct Walk {
    /// Every path the walk accepted, relative to the root.
    pub paths: Vec<String>,
    pub errors: Vec<String>,
}

/// A named `include` is a whitelist and beats `.gitignore`, as `git add -f` does.
/// A catch-all says the opposite, so it adds no rule.
fn selection(root: &Path, config: &Config) -> anyhow::Result<Override> {
    let mut overrides = OverrideBuilder::new(root);

    if !config.include.iter().any(|p| is_catch_all(p)) {
        for pattern in &config.include {
            // A gitignored directory is pruned before the walk looks inside.
            for parent in literal_parents(pattern) {
                overrides.add(&parent)?;
            }
            overrides.add(pattern)?;
        }
    }

    for pattern in &config.exclude {
        overrides.add(&format!("!{pattern}"))?;
    }

    Ok(overrides.build()?)
}

/// `src/api/*.rs` names `src` and `src/api`. `*.rs` names none.
fn literal_parents(pattern: &str) -> Vec<String> {
    let mut parents = Vec::new();
    let mut path = String::new();

    for part in pattern.split('/').take_while(|p| !p.contains(['*', '?'])) {
        if !path.is_empty() {
            path.push('/');
        }
        path.push_str(part);
        parents.push(path.clone());
    }

    // A pattern with no wildcard names a file, not a directory.
    if !pattern.contains(['*', '?']) {
        parents.pop();
    }

    parents
}

fn is_catch_all(pattern: &str) -> bool {
    matches!(pattern, "*" | "**" | "**/*")
}

pub(super) fn discover(
    root: &Path,
    config: &Config,
    mut progress: impl FnMut(&str, usize) -> std::io::Result<()>,
) -> anyhow::Result<Walk> {
    let entries = WalkBuilder::new(root)
        .overrides(selection(root, config)?)
        // A dotfile is configuration, which is what an agent asks about.
        .hidden(false)
        .sort_by_file_path(|left, right| left.cmp(right))
        .build();
    let mut walk = Walk::default();

    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(e) => {
                walk.errors.push(e.to_string());
                continue;
            }
        };

        // Entries can carry recoverable errors, such as a malformed ignore file.
        if let Some(error) = entry.error() {
            walk.errors.push(error.to_string());
        }

        // A directory, a symlink, and a device hold no text of their own.
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }

        let relative = entry.path().strip_prefix(root).unwrap_or(entry.path());
        let path = relative.to_string_lossy().into_owned();
        progress(&path, walk.paths.len() + 1)?;
        walk.paths.push(path);
    }

    walk.paths.sort();

    Ok(walk)
}

#[cfg(test)]
#[path = "../../../tests/unit/commands/index/walk.rs"]
mod tests;
