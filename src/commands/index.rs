use std::fs;
use std::path::Path;

use ignore::WalkBuilder;
use ignore::overrides::{Override, OverrideBuilder};

use crate::config::Config;

#[derive(Debug, Default, PartialEq)]
pub struct Walk {
    /// Every path the walk accepted, relative to the root.
    pub paths: Vec<String>,
    pub skipped: usize,
}

pub fn run() -> anyhow::Result<()> {
    let root = Path::new(".");
    let config = Config::load(root)?;

    let walk = walk(root, &config)?;

    for path in &walk.paths {
        println!("{path}");
    }

    println!(
        "{} files walked, {} skipped",
        walk.paths.len(),
        walk.skipped
    );

    Ok(())
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

fn walk(root: &Path, config: &Config) -> anyhow::Result<Walk> {
    let entries = WalkBuilder::new(root)
        .overrides(selection(root, config)?)
        // A dotfile is configuration, which is what an agent asks about.
        .hidden(false)
        .build();
    let mut walk = Walk::default();

    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(e) => {
                walk.skipped += 1;
                eprintln!("skipped: {e}");
                continue;
            }
        };

        // A directory, a symlink, and a device hold no text of their own.
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }

        // One call rejects the file the process cannot read and the file that is not UTF-8.
        if let Err(e) = fs::read_to_string(entry.path()) {
            walk.skipped += 1;
            eprintln!("skipped: {}: {e}", entry.path().display());
            continue;
        }

        let relative = entry.path().strip_prefix(root).unwrap_or(entry.path());
        walk.paths.push(relative.to_string_lossy().into_owned());
    }

    walk.paths.sort();

    Ok(walk)
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use tempfile::TempDir;

    use super::*;

    /// No `.gitignore`, so the walk sees every file.
    fn tree(files: &[(&str, &str)]) -> TempDir {
        let dir = TempDir::new().unwrap();
        for (path, contents) in files {
            let path = dir.path().join(path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, contents).unwrap();
        }

        dir
    }

    fn config(include: &[&str], exclude: &[&str]) -> Config {
        Config {
            include: include.iter().map(|s| s.to_string()).collect(),
            exclude: exclude.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn every_file_is_walked() {
        let dir = tree(&[("a.txt", "hello"), ("src/b.rs", "fn main() {}")]);

        let walk = walk(dir.path(), &config(&["**/*"], &[])).unwrap();

        assert_eq!(
            walk,
            Walk {
                paths: vec!["a.txt".to_string(), "src/b.rs".to_string()],
                skipped: 0,
            }
        );
    }

    #[test]
    fn exclude_removes_a_directory() {
        let dir = tree(&[("a.txt", "hello"), ("target/b.txt", "skip me")]);

        let walk = walk(dir.path(), &config(&["**/*"], &["**/target/**"])).unwrap();

        assert_eq!(walk.paths, ["a.txt"]);
    }

    #[test]
    fn include_selects_one_extension() {
        let dir = tree(&[("a.txt", "hello"), ("b.rs", "fn main() {}")]);

        let walk = walk(dir.path(), &config(&["**/*.rs"], &[])).unwrap();

        assert_eq!(walk.paths, ["b.rs"]);
    }

    #[test]
    fn a_symlink_is_not_followed() {
        let dir = tree(&[("real/a.txt", "hello")]);
        std::os::unix::fs::symlink(dir.path().join("real"), dir.path().join("link")).unwrap();

        let walk = walk(dir.path(), &config(&["**/*"], &[])).unwrap();

        assert_eq!(walk.paths, ["real/a.txt"]);
    }

    #[test]
    fn an_unreadable_file_is_skipped() {
        let dir = tree(&[("a.txt", "hello"), ("locked.txt", "secret")]);
        let locked = dir.path().join("locked.txt");
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();

        let walk = walk(dir.path(), &config(&["**/*"], &[])).unwrap();

        assert_eq!(walk.paths, ["a.txt"]);
        assert_eq!(walk.skipped, 1);
    }

    #[test]
    fn an_undecodable_file_is_skipped() {
        let dir = tree(&[("a.txt", "keep")]);
        // "zolc" in Windows-1250: not valid UTF-8.
        fs::write(dir.path().join("b.txt"), [0xbf, 0xf3, 0xb3, 0xe6]).unwrap();

        let walk = walk(dir.path(), &config(&["**/*"], &[])).unwrap();

        assert_eq!(walk.paths, ["a.txt"]);
        assert_eq!(walk.skipped, 1);
    }

    #[test]
    fn utf8_beyond_ascii_is_text() {
        let dir = tree(&[]);
        fs::write(
            dir.path().join("pl.txt"),
            "\u{017c}\u{00f3}\u{0142}\u{0107}",
        )
        .unwrap();
        fs::write(dir.path().join("jp.txt"), "\u{65e5}\u{672c}\u{8a9e}").unwrap();

        let walk = walk(dir.path(), &config(&["**/*"], &[])).unwrap();

        assert_eq!(walk.paths, ["jp.txt", "pl.txt"]);
        assert_eq!(walk.skipped, 0);
    }

    #[test]
    fn a_large_file_is_walked() {
        let dir = tree(&[("a.txt", "hello")]);
        let big = "x".repeat(8 * 1024 * 1024);
        fs::write(dir.path().join("big.txt"), big).unwrap();

        let walk = walk(dir.path(), &config(&["**/*"], &[])).unwrap();

        assert_eq!(walk.paths, ["a.txt", "big.txt"]);
        assert_eq!(walk.skipped, 0);
    }

    /// `ignore` reads a `.gitignore` only inside a git repository.
    fn gitignore(dir: &TempDir, patterns: &str) {
        fs::create_dir_all(dir.path().join(".git")).unwrap();
        fs::write(dir.path().join(".gitignore"), patterns).unwrap();
    }

    #[test]
    fn a_catch_all_include_leaves_gitignore_in_charge() {
        let dir = tree(&[("a.txt", "keep"), ("build/out.txt", "drop")]);
        gitignore(&dir, "build/\n");

        let walk = walk(dir.path(), &config(&["**/*"], &[])).unwrap();

        assert_eq!(walk.paths, [".gitignore", "a.txt"]);
    }

    #[test]
    fn a_named_include_beats_gitignore() {
        let dir = tree(&[("a.txt", "keep"), ("build/out.txt", "wanted")]);
        gitignore(&dir, "build/\n");

        let walk = walk(dir.path(), &config(&["build/**"], &[])).unwrap();

        assert_eq!(walk.paths, ["build/out.txt"]);
    }

    #[test]
    fn the_index_is_never_walked() {
        let dir = tree(&[("a.txt", "keep"), (".mimirs/config.toml", "include = []")]);

        let walk = walk(dir.path(), &Config::default()).unwrap();

        assert_eq!(walk.paths, ["a.txt"]);
    }

    #[test]
    fn literal_parents_stop_at_the_first_wildcard() {
        assert_eq!(literal_parents("build/**"), ["build"]);
        assert_eq!(literal_parents("src/api/*.rs"), ["src", "src/api"]);
        assert_eq!(literal_parents("src/**/*.rs"), ["src"]);
        assert_eq!(literal_parents("a/b/c.rs"), ["a", "a/b"]);
        assert!(literal_parents("*.rs").is_empty());
        assert!(literal_parents("README.md").is_empty());
    }

    #[test]
    fn a_secret_is_never_walked() {
        let dir = tree(&[
            ("a.txt", "keep"),
            (".env", "TOKEN=x"),
            (".env.local", "TOKEN=x"),
            ("keys/id_rsa", "private"),
            ("certs/server.pem", "private"),
            (".npmrc", "//registry:_authToken=x"),
        ]);

        let walk = walk(dir.path(), &Config::default()).unwrap();

        assert_eq!(walk.paths, ["a.txt"]);
    }

    #[test]
    fn a_bad_glob_is_an_error() {
        let dir = tree(&[("a.txt", "hello")]);

        assert!(walk(dir.path(), &config(&["["], &[])).is_err());
    }
}
