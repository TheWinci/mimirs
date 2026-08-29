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
fn default_include_selects_rust_files() {
    let dir = tree(&[
        ("a.txt", "hello"),
        ("b.rs", "fn main() {}"),
        ("src/lib.rs", "pub fn answer() -> u8 { 42 }"),
    ]);

    let walk = walk(dir.path(), &Config::default()).unwrap();

    assert_eq!(walk.paths, ["b.rs", "src/lib.rs"]);
}

#[test]
fn custom_include_selects_another_extension() {
    let dir = tree(&[("a.txt", "hello"), ("b.rs", "fn main() {}")]);

    let walk = walk(dir.path(), &config(&["**/*.txt"], &[])).unwrap();

    assert_eq!(walk.paths, ["a.txt"]);
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
    let dir = tree(&[("a.rs", "keep"), (".mimirs/leak.rs", "drop")]);

    let walk = walk(dir.path(), &Config::default()).unwrap();

    assert_eq!(walk.paths, ["a.rs"]);
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

    let config = Config {
        include: vec!["**/*".to_string()],
        ..Config::default()
    };

    let walk = walk(dir.path(), &config).unwrap();

    assert_eq!(walk.paths, ["a.txt"]);
}

#[test]
fn a_bad_glob_is_an_error() {
    let dir = tree(&[("a.txt", "hello")]);

    assert!(walk(dir.path(), &config(&["["], &[])).is_err());
}
