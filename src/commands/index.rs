use std::io::{IsTerminal, Write};
use std::path::Path;

use anyhow::Context;
use clap::Args;

use crate::chunk::chunk;
use crate::config::Config;
use crate::discover::discover;
use crate::embed::{self, Embedder};
use crate::files::read::read_text;
use crate::store::{FileRecord, Store};

#[derive(Args)]
pub struct Options {}

pub fn run(_options: Options) -> anyhow::Result<()> {
    let root = std::env::current_dir()?;
    index_project(&root)
}

#[derive(Default)]
struct Summary {
    files: usize,
    chunks: usize,
    windows: usize,
    not_text: usize,
    unreadable: usize,
}

/// Bring the index in `root/.mimirs/index.db` up to date with the project's files.
pub fn index_project(root: &Path) -> anyhow::Result<()> {
    let config = Config::load(&root.join(".mimirs/config.toml"))?;
    let model_files = embed::cached_files(&embed::cache_dir()?)
        .context("The embedding model is not downloaded; run `mimirs init` first")?;
    let tokenizer = embed::load_tokenizer(&model_files.tokenizer)?;
    let mut embedder = Embedder::load(&model_files)?;
    let mut store = Store::open(&root.join(".mimirs/index.db"))?;

    let discovery = discover(root, &config)?;
    for error in &discovery.errors {
        eprintln!("{error}");
    }

    let show_progress = std::io::stderr().is_terminal();
    let total = discovery.files.len();
    let mut summary = Summary::default();
    for (done, file) in discovery.files.iter().enumerate() {
        if show_progress {
            eprint!("\r\x1b[2K{done}/{total} files · {}", file.path.display());
            std::io::stderr().flush()?;
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

        let chunks = chunk(&text, &tokenizer)?;
        let mut vectors = Vec::new();
        for chunk in &chunks {
            for window in &chunk.windows {
                vectors.push(embedder.embed(chunk.window_text(window))?);
            }
        }
        let path = file.path.to_string_lossy().replace('\\', "/");
        let record = FileRecord {
            path: &path,
            size: file.size,
            modified: file.modified,
        };
        store.write_file(&record, &chunks, &vectors)?;

        summary.files += 1;
        summary.chunks += chunks.len();
        summary.windows += vectors.len();
    }
    clear_progress_line(show_progress);
    store.record_finished_run()?;

    println!(
        "{} files: {} chunks, {} windows",
        summary.files, summary.chunks, summary.windows
    );
    println!(
        "skipped: {} not UTF-8, {} over 50 MB, {} unreadable",
        summary.not_text, discovery.skipped_too_large, summary.unreadable
    );
    Ok(())
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
}
