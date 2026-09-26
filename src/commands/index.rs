use std::collections::HashSet;
use std::io::{IsTerminal, Write};
use std::path::Path;

use anyhow::Context;
use clap::Args;

use crate::chunk::{Chunk, chunk};
use crate::config::Config;
use crate::discover::{DiscoveredFile, Discovery, discover};
use crate::embed::{self, Embedder};
use crate::files::read::read_text;
use crate::store::{FileRecord, Store};

/// Windows gathered from several files before embedding them together. Models
/// wait for the slowest one only at the end of a batch, not after every file.
const WINDOWS_PER_BATCH: usize = 128;

#[derive(Args)]
pub struct Options {}

pub fn run(_options: Options) -> anyhow::Result<()> {
    let root = std::env::current_dir()?;
    let summary = index_project(&root)?;
    println!(
        "{} files indexed: {} chunks, {} windows",
        summary.files, summary.chunks, summary.windows
    );
    println!(
        "{} unchanged, {} removed",
        summary.unchanged, summary.removed
    );
    println!(
        "skipped: {} not UTF-8, {} over 50 MB, {} unreadable",
        summary.not_text, summary.too_large, summary.unreadable
    );
    Ok(())
}

/// What one `index` run did.
#[derive(Default)]
pub struct Summary {
    files: usize,
    unchanged: usize,
    removed: usize,
    chunks: usize,
    windows: usize,
    not_text: usize,
    too_large: usize,
    unreadable: usize,
}

/// A file read and chunked, waiting to be embedded and written.
struct PreparedFile {
    path: String,
    size: u64,
    modified: i64,
    chunks: Vec<Chunk>,
}

impl PreparedFile {
    fn window_count(&self) -> usize {
        self.chunks.iter().map(|chunk| chunk.windows.len()).sum()
    }
}

/// Bring the index in `root/.mimirs/index.db` up to date with the project's files.
pub fn index_project(root: &Path) -> anyhow::Result<Summary> {
    let config = Config::load(&root.join(".mimirs/config.toml"))?;
    let model_files = embed::cached_files(&embed::cache_dir()?)
        .context("The embedding model is not downloaded; run `mimirs init` first")?;
    let tokenizer = embed::load_tokenizer(&model_files.tokenizer)?;
    let mut embedder = Embedder::load(&model_files, config.threads)?;
    let mut store = Store::open(&root.join(".mimirs/index.db"))?;

    let discovery = discover(root, &config)?;
    for error in &discovery.errors {
        eprintln!("{error}");
    }

    let known_files = store.file_states()?;
    let show_progress = std::io::stderr().is_terminal();
    let terminal_width = terminal_size::terminal_size_of(std::io::stderr())
        .map_or(80, |(width, _)| usize::from(width.0));
    let total = discovery.files.len();
    let mut summary = Summary {
        too_large: discovery.skipped_too_large,
        ..Summary::default()
    };
    let mut batch: Vec<PreparedFile> = Vec::new();
    let mut batch_windows = 0;
    for (done, file) in discovery.files.iter().enumerate() {
        if show_progress {
            let line = progress_line(done, total, &file.path.to_string_lossy(), terminal_width);
            eprint!("\r\x1b[2K{line}");
            std::io::stderr().flush()?;
        }
        let path = stored_path(file);
        if is_unchanged(known_files.get(&path), file) {
            summary.unchanged += 1;
            continue;
        }
        let text = match read_text(&root.join(&file.path)) {
            Ok(Some(text)) => text,
            Ok(None) => {
                summary.not_text += 1;
                continue;
            }
            Err(error) => {
                // A file can vanish or become unreadable after the walk; the rest
                // of the project still gets indexed.
                clear_progress_line(show_progress);
                eprintln!("Could not read {}: {error}", file.path.display());
                summary.unreadable += 1;
                continue;
            }
        };

        let prepared = PreparedFile {
            path,
            size: file.size,
            modified: file.modified,
            chunks: chunk(&text, &tokenizer)?,
        };
        batch_windows += prepared.window_count();
        batch.push(prepared);
        if batch_windows >= WINDOWS_PER_BATCH {
            embed_and_write(&batch, &mut embedder, &mut store, &mut summary)?;
            batch.clear();
            batch_windows = 0;
        }
    }
    embed_and_write(&batch, &mut embedder, &mut store, &mut summary)?;
    clear_progress_line(show_progress);

    if walk_found_everything(&discovery) {
        let found_paths: HashSet<String> = discovery.files.iter().map(stored_path).collect();
        summary.removed = store.remove_files_except(&found_paths)?;
    }
    store.record_finished_run()?;
    Ok(summary)
}

/// Embed every window of `batch` in one parallel pass, then write each file in
/// its own transaction.
fn embed_and_write(
    batch: &[PreparedFile],
    embedder: &mut Embedder,
    store: &mut Store,
    summary: &mut Summary,
) -> anyhow::Result<()> {
    let window_texts: Vec<&str> = batch
        .iter()
        .flat_map(|file| &file.chunks)
        .flat_map(|chunk| chunk.windows.iter().map(|window| chunk.window_text(window)))
        .collect();
    let vectors = embedder.embed_all(&window_texts)?;

    let mut remaining_vectors = vectors.as_slice();
    for file in batch {
        let (file_vectors, rest) = remaining_vectors.split_at(file.window_count());
        remaining_vectors = rest;
        let record = FileRecord {
            path: &file.path,
            size: file.size,
            modified: file.modified,
        };
        store.write_file(&record, &file.chunks, file_vectors)?;

        summary.files += 1;
        summary.chunks += file.chunks.len();
        summary.windows += file_vectors.len();
    }
    Ok(())
}

/// The path as stored in the index: relative to the root, with `/` separators.
fn stored_path(file: &DiscoveredFile) -> String {
    file.path.to_string_lossy().replace('\\', "/")
}

/// A file is unchanged when its size and modification time match its record.
/// An unknown modification time never counts as unchanged.
fn is_unchanged(known: Option<&(u64, i64)>, file: &DiscoveredFile) -> bool {
    file.modified != 0 && known == Some(&(file.size, file.modified))
}

/// Records may only be removed after a walk that saw the whole project. A walk
/// with errors or no files could otherwise delete the whole index.
fn walk_found_everything(discovery: &Discovery) -> bool {
    discovery.errors.is_empty() && !discovery.files.is_empty()
}

/// One progress line that fits `width` columns. A line that wraps cannot be
/// cleared in place, so long paths lose their start instead.
fn progress_line(done: usize, total: usize, path: &str, width: usize) -> String {
    let prefix = format!("{done}/{total} files · ");
    // Stay off the last column, where some terminals wrap early.
    let room = width.saturating_sub(prefix.chars().count() + 1);
    let path_length = path.chars().count();
    if path_length <= room {
        return format!("{prefix}{path}");
    }
    if room < 2 {
        return prefix.chars().take(width.saturating_sub(1)).collect();
    }
    let tail: String = path.chars().skip(path_length - (room - 1)).collect();
    format!("{prefix}…{tail}")
}

fn clear_progress_line(show_progress: bool) {
    if show_progress {
        eprint!("\r\x1b[2K");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use std::fs;

    #[test]
    #[ignore = "downloads and runs the real model"]
    fn indexes_a_small_project() -> anyhow::Result<()> {
        embed::download(&embed::cache_dir()?)?;
        let project = tempfile::tempdir()?;
        let root = project.path();
        fs::create_dir_all(root.join(".mimirs"))?;
        fs::write(
            root.join(".mimirs/config.toml"),
            Config::default().to_toml()?,
        )?;
        fs::create_dir_all(root.join("src"))?;
        fs::write(root.join("src/token.rs"), "fn refresh_token() {}\n")?;
        fs::write(root.join("README.md"), "# Example\n\nA small project.\n")?;

        index_project(root)?;

        let database = Connection::open(root.join(".mimirs/index.db"))?;
        let count = |table: &str| -> anyhow::Result<i64> {
            Ok(
                database.query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                    row.get(0)
                })?,
            )
        };
        assert_eq!(count("files")?, 2);
        assert_eq!(count("chunks")?, 2);
        assert_eq!(count("window_vectors")?, count("windows")?);
        Ok(())
    }

    #[test]
    fn progress_lines_fit_the_terminal_width() {
        let path = "tests/fixtures_regress/fixtures/non_natural_2.xml";
        assert_eq!(
            progress_line(46, 3729, "src/a.rs", 80),
            "46/3729 files · src/a.rs"
        );
        let line = progress_line(46, 3729, path, 40);
        assert_eq!(line, "46/3729 files · …ures/non_natural_2.xml");
        assert!(line.chars().count() < 40);
        assert!(progress_line(46, 3729, path, 10).chars().count() < 10);
    }

    fn discovered(size: u64, modified: i64) -> DiscoveredFile {
        DiscoveredFile {
            path: "src/a.rs".into(),
            size,
            modified,
        }
    }

    #[test]
    fn unchanged_means_same_size_and_modification_time() {
        let known = (10, 500);
        assert!(is_unchanged(Some(&known), &discovered(10, 500)));
        assert!(!is_unchanged(Some(&known), &discovered(11, 500)));
        assert!(!is_unchanged(Some(&known), &discovered(10, 501)));
        assert!(!is_unchanged(None, &discovered(10, 500)));
        assert!(!is_unchanged(Some(&(10, 0)), &discovered(10, 0)));
    }

    #[test]
    fn removal_needs_a_complete_walk_that_found_files() {
        let walk = |files: Vec<DiscoveredFile>, errors: Vec<String>| Discovery {
            files,
            skipped_too_large: 0,
            errors,
        };
        assert!(walk_found_everything(&walk(vec![discovered(1, 1)], vec![])));
        assert!(!walk_found_everything(&walk(vec![], vec![])));
        assert!(!walk_found_everything(&walk(
            vec![discovered(1, 1)],
            vec!["permission denied".into()]
        )));
    }

    #[test]
    #[ignore = "downloads and runs the real model"]
    fn a_second_run_only_does_work_for_changes() -> anyhow::Result<()> {
        embed::download(&embed::cache_dir()?)?;
        let project = tempfile::tempdir()?;
        let root = project.path();
        fs::create_dir_all(root.join(".mimirs"))?;
        fs::write(
            root.join(".mimirs/config.toml"),
            Config::default().to_toml()?,
        )?;
        fs::create_dir_all(root.join("src"))?;
        fs::write(root.join("src/a.rs"), "fn a() {}\n")?;
        fs::write(root.join("src/b.rs"), "fn b() {}\n")?;
        fs::write(root.join("src/c.rs"), "fn c() {}\n")?;
        assert_eq!(index_project(root)?.files, 3);

        let second = index_project(root)?;
        assert_eq!((second.files, second.unchanged, second.removed), (0, 3, 0));

        fs::write(root.join("src/a.rs"), "fn a() { println!(\"edited\"); }\n")?;
        fs::remove_file(root.join("src/b.rs"))?;
        let third = index_project(root)?;
        assert_eq!((third.files, third.unchanged, third.removed), (1, 1, 1));

        let mut config = Config::default();
        config.exclude.push("src/c.rs".into());
        fs::write(root.join(".mimirs/config.toml"), config.to_toml()?)?;
        let fourth = index_project(root)?;
        assert_eq!((fourth.files, fourth.unchanged, fourth.removed), (0, 1, 1));
        Ok(())
    }
}
