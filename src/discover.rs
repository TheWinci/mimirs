use std::fs::Metadata;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::UNIX_EPOCH;

use anyhow::{Context, Result};
use globset::{Glob, GlobSet, GlobSetBuilder};
use ignore::{IncrementalIgnore, WalkBuilder, WalkState};

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

    let excluded_dirs = excluded_dir_set(&config.exclude)?;
    let walk_root = root.to_path_buf();
    let walk = walk_builder(root)
        .threads(config.threads)
        // Skipping excluded directories saves reading them; `.git` is the big one,
        // because `.hidden(false)` lets the walk in and no ignore file covers it.
        .filter_entry(move |entry| {
            let is_dir = entry.file_type().is_some_and(|kind| kind.is_dir());
            match entry.path().strip_prefix(&walk_root) {
                Ok(relative_path) if is_dir => !excluded_dirs.is_match(relative_path),
                _ => true,
            }
        })
        .build_parallel();

    let (entry_sender, entry_receiver) = mpsc::channel();
    walk.run(|| {
        let entry_sender = entry_sender.clone();
        Box::new(move |entry| {
            // The receiver lives until the walk ends, so sending cannot fail.
            let _ = entry_sender.send(entry);
            WalkState::Continue
        })
    });
    drop(entry_sender);

    for entry in entry_receiver {
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
        discovery.files.push(DiscoveredFile {
            path: relative_path.to_path_buf(),
            size,
            modified: modified_nanos(&metadata),
        });
    }
    // The parallel walk finds files in a different order on every run.
    discovery.files.sort_by(|a, b| a.path.cmp(&b.path));
    discovery.errors.sort();
    Ok(discovery)
}

/// The walk's ignore-file rules, shared by `discover` and `PathMatcher` so both
/// agree on what is ignored.
fn walk_builder(root: &Path) -> WalkBuilder {
    let mut builder = WalkBuilder::new(root);
    // Dot-files such as CI configs are useful context; secrets are excluded by pattern.
    // `.gitignore` must also apply in folders that are not git repositories.
    builder.hidden(false).require_git(false);
    builder
}

fn modified_nanos(metadata: &Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |elapsed| elapsed.as_nanos() as i64)
}

/// Decides whether one path belongs in the index by the same rules as
/// `discover`, without walking the project.
pub struct PathMatcher {
    include: GlobSet,
    exclude: GlobSet,
    /// Reads each folder's ignore files on first use and keeps them, so it must
    /// be rebuilt after an ignore file changes.
    ignore: IncrementalIgnore,
}

impl PathMatcher {
    pub fn new(root: &Path, config: &Config) -> Result<Self> {
        let ignore = walk_builder(root)
            .build_matchers()
            .into_iter()
            .next()
            .context("The walk has no root to match paths against")?;
        Ok(Self {
            include: glob_set(&config.include)?,
            exclude: glob_set(&config.exclude)?,
            ignore,
        })
    }

    /// The file at `relative_path` as `discover` would list it, or `None` when
    /// `discover` would skip it. `metadata` must come from `symlink_metadata`,
    /// so a symlink is skipped as the walk skips it.
    pub fn file(&mut self, relative_path: &Path, metadata: &Metadata) -> Option<DiscoveredFile> {
        let listed = metadata.is_file()
            && self.include.is_match(relative_path)
            && !self.exclude.is_match(relative_path)
            && metadata.len() <= MAX_FILE_BYTES
            // Checks the ignore files of every parent folder too.
            && !self.ignore.matched(relative_path, false).is_ignore();
        listed.then(|| DiscoveredFile {
            path: relative_path.to_path_buf(),
            size: metadata.len(),
            modified: modified_nanos(metadata),
        })
    }
}

/// Directory patterns from the exclude patterns that end in `/**`: `.git/**`
/// gives `.git`. Such a pattern excludes every file under the directory, so the
/// walk can skip the directory without changing what it finds.
pub fn excluded_dir_set(exclude: &[String]) -> Result<GlobSet> {
    let dir_patterns: Vec<String> = exclude
        .iter()
        .filter_map(|pattern| pattern.strip_suffix("/**"))
        .map(str::to_string)
        .collect();
    glob_set(&dir_patterns)
}

pub fn glob_set(patterns: &[String]) -> Result<GlobSet> {
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
    fn skips_excluded_directories_and_sorts_files() -> Result<()> {
        let project = tempfile::tempdir()?;
        let root = project.path();
        write(root, "vendor/lib.rs", b"")?;
        write(root, "src/b.rs", b"")?;
        write(root, "src/a.rs", b"")?;
        write(root, "src/vendor/kept.rs", b"")?;
        let config = Config {
            include: vec!["**/*.rs".into()],
            exclude: vec!["vendor/**".into()],
            ..Config::default()
        };

        let paths: Vec<PathBuf> = discover(root, &config)?
            .files
            .into_iter()
            .map(|file| file.path)
            .collect();
        let expected: Vec<PathBuf> = ["src/a.rs", "src/b.rs", "src/vendor/kept.rs"]
            .iter()
            .map(PathBuf::from)
            .collect();
        assert_eq!(paths, expected);
        let excluded_dirs = excluded_dir_set(&config.exclude)?;
        assert!(excluded_dirs.is_match("vendor"));
        assert!(!excluded_dirs.is_match("src/vendor"));
        Ok(())
    }

    #[test]
    fn path_matcher_agrees_with_the_walk() -> Result<()> {
        let project = tempfile::tempdir()?;
        let root = project.path();
        write(root, "src/main.rs", b"fn main() {}")?;
        write(root, "src/logo.png", b"")?;
        write(root, "target/debug/build.rs", b"")?;
        write(root, "generated/deep/out.rs", b"")?;
        write(root, "generated/.gitignore", b"")?;
        write(root, ".gitignore", b"generated/\n")?;
        let config = Config::default();
        let mut matcher = PathMatcher::new(root, &config)?;

        let mut listed = |relative_path: &str| -> Result<bool> {
            let metadata = fs::symlink_metadata(root.join(relative_path))?;
            Ok(matcher.file(Path::new(relative_path), &metadata).is_some())
        };
        assert!(listed("src/main.rs")?);
        assert!(!listed("src/logo.png")?);
        assert!(!listed("target/debug/build.rs")?);
        // Ignored through its parent folder, as in the walk.
        assert!(!listed("generated/deep/out.rs")?);
        assert_eq!(discovered_paths(root, &config)?, ["src/main.rs"]);
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
