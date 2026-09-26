use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use anyhow::Result;
use globset::{Glob, GlobSet, GlobSetBuilder};
use ignore::WalkBuilder;

use crate::config::Config;

/// Files larger than this are skipped, as in v1, to guard against stray giants.
const MAX_FILE_BYTES: u64 = 50 * 1024 * 1024;

/// A file the walk found, with its path relative to the project root.
pub struct DiscoveredFile {
    pub path: PathBuf,
    pub size: u64,
    /// Modification time in nanoseconds since the Unix epoch, or 0 when unknown.
    pub modified: i64,
}

/// The result of one walk over the project.
pub struct Discovery {
    pub files: Vec<DiscoveredFile>,
    pub skipped_too_large: usize,
    /// Entries the walk could not read, such as unreadable folders.
    pub errors: Vec<String>,
}

/// List the project's regular files that the config includes and no ignore file or
/// exclude pattern removes. Symlinks are not followed.
pub fn discover(root: &Path, config: &Config) -> Result<Discovery> {
    let include = glob_set(&config.include)?;
    let exclude = glob_set(&config.exclude)?;
    let mut discovery = Discovery {
        files: Vec::new(),
        skipped_too_large: 0,
        errors: Vec::new(),
    };

    // Dot-files such as CI configs are useful context; secrets are excluded by pattern.
    // `.gitignore` must also apply in folders that are not git repositories.
    let walk = WalkBuilder::new(root)
        .hidden(false)
        .require_git(false)
        .build();
    for entry in walk {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                discovery.errors.push(error.to_string());
                continue;
            }
        };
        let is_file = entry.file_type().is_some_and(|kind| kind.is_file());
        if !is_file {
            continue;
        }
        let relative_path = entry.path().strip_prefix(root)?;
        if !include.is_match(relative_path) || exclude.is_match(relative_path) {
            continue;
        }
        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(error) => {
                discovery.errors.push(error.to_string());
                continue;
            }
        };
        let size = metadata.len();
        if size > MAX_FILE_BYTES {
            discovery.skipped_too_large += 1;
            continue;
        }
        let modified = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |elapsed| elapsed.as_nanos() as i64);
        discovery.files.push(DiscoveredFile {
            path: relative_path.to_path_buf(),
            size,
            modified,
        });
    }
    Ok(discovery)
}

fn glob_set(patterns: &[String]) -> Result<GlobSet> {
    let mut builder = GlobSetBuilder::new();
    for pattern in patterns {
        builder.add(Glob::new(pattern)?);
    }
    Ok(builder.build()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write(root: &Path, relative_path: &str, contents: &[u8]) -> Result<()> {
        let path = root.join(relative_path);
        fs::create_dir_all(path.parent().unwrap())?;
        fs::write(path, contents)?;
        Ok(())
    }

    fn discovered_paths(root: &Path, config: &Config) -> Result<Vec<String>> {
        let mut paths: Vec<String> = discover(root, config)?
            .files
            .into_iter()
            .map(|file| file.path.to_string_lossy().replace('\\', "/"))
            .collect();
        paths.sort();
        Ok(paths)
    }

    #[test]
    fn applies_default_lists_ignore_files_and_dot_files() -> Result<()> {
        let project = tempfile::tempdir()?;
        let root = project.path();
        write(root, "src/main.rs", b"fn main() {}")?;
        write(root, ".github/workflows/ci.yml", b"on: push")?;
        write(root, ".env", b"SECRET=1")?;
        write(root, "config/.env.local", b"SECRET=1")?;
        write(root, "node_modules/lib/index.js", b"")?;
        write(root, "target/debug/build.rs", b"")?;
        write(root, "package-lock.json", b"{}")?;
        write(root, "generated/out.rs", b"")?;
        write(root, ".gitignore", b"generated/\n")?;
        write(root, ".mimirs/config.toml", b"")?;

        assert_eq!(
            discovered_paths(root, &Config::default())?,
            [".github/workflows/ci.yml", "src/main.rs"]
        );
        Ok(())
    }

    #[test]
    fn matches_patterns_relative_to_the_root() -> Result<()> {
        let project = tempfile::tempdir()?;
        let root = project.path();
        write(root, "build/output.rs", b"")?;
        write(root, "src/build/helper.rs", b"")?;
        let config = Config {
            include: vec!["**/*.rs".into()],
            exclude: vec!["build/**".into()],
            ..Config::default()
        };
        assert_eq!(discovered_paths(root, &config)?, ["src/build/helper.rs"]);
        Ok(())
    }
}
