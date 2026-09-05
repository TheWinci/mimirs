use std::io::{self, IsTerminal, Write};
use std::path::Path;
use std::time::{Duration, Instant};

use anyhow::Context;

use crate::{chunk, config::Config, embedding, source, storage, window};

mod progress;
mod walk;

use progress::Progress;

pub fn run() -> anyhow::Result<()> {
    let start = Instant::now();
    let stderr = io::stderr();
    let terminal = stderr.is_terminal();
    run_at(
        Path::new("."),
        embedding::production,
        &mut io::stdout().lock(),
        &mut stderr.lock(),
        terminal,
        &|| start.elapsed(),
    )
}

fn run_at(
    root: &Path,
    make_embedder: impl FnOnce() -> anyhow::Result<embedding::Embedder>,
    stdout: &mut dyn Write,
    stderr: &mut dyn Write,
    terminal: bool,
    elapsed: &dyn Fn() -> Duration,
) -> anyhow::Result<()> {
    let mut progress = Progress::new(root, stderr, terminal, elapsed);
    let result = index(root, make_embedder, &mut progress);
    // Clear even on failure, before main prints the error.
    let cleared = progress.clear();
    let summary = result?;
    cleared?;
    writeln!(
        stdout,
        "indexed: {} files\nunchanged: {} files\nskipped: {} files\nwalk_errors: {}\ntime: {:.2} seconds",
        summary.indexed,
        summary.unchanged,
        summary.skipped,
        summary.walk_errors,
        elapsed().as_secs_f64(),
    )?;
    Ok(())
}

#[derive(Default)]
struct Summary {
    indexed: usize,
    unchanged: usize,
    skipped: usize,
    walk_errors: usize,
}

fn index(
    root: &Path,
    make_embedder: impl FnOnce() -> anyhow::Result<embedding::Embedder>,
    progress: &mut Progress<'_>,
) -> anyhow::Result<Summary> {
    index_with(
        root,
        make_embedder,
        progress,
        source::read,
        crate::analysis::extract,
    )
}

fn index_with(
    root: &Path,
    make_embedder: impl FnOnce() -> anyhow::Result<embedding::Embedder>,
    progress: &mut Progress<'_>,
    read: impl Fn(&Path, &str) -> anyhow::Result<source::SourceFile>,
    extract: impl Fn(source::SourceFile) -> anyhow::Result<crate::analysis::Analysis>,
) -> anyhow::Result<Summary> {
    let config = Config::load(root)?;
    progress.walking("-", 0)?;
    let walk = walk::discover(root, &config, |file, found| progress.walking(file, found))?;
    for error in &walk.errors {
        progress.diagnostic(&format!("walk_error: {error}"))?;
    }

    let database_path = root.join(".mimirs/index.db");
    let mut database = storage::open(&database_path)?;
    if database.outcome != storage::OpenOutcome::Reused {
        progress.diagnostic(&database.outcome.message(&database_path))?;
    }
    let mut embedder = make_embedder()?;
    storage::validate_model(&database.connection)?;
    embedder.prepare()?;

    let mut summary = Summary {
        walk_errors: walk.errors.len(),
        ..Summary::default()
    };
    let mut successful = Vec::new();
    let total = walk.paths.len();
    for (attempt, path) in walk.paths.iter().enumerate() {
        progress.indexing(path, (0, 0), (attempt, total), false)?;
        let source = match read(root, path) {
            Ok(source) => source,
            Err(error) => {
                progress.diagnostic(&format!("skipped: {error:#}"))?;
                summary.skipped += 1;
                progress.indexing(path, (0, 0), (attempt + 1, total), true)?;
                continue;
            }
        };
        let hash = storage::processing::source_hash(&source.text);
        let rust = Path::new(path).extension().is_some_and(|ext| ext == "rs");
        if storage::processing::reusable(&database.connection, &source, &hash, rust)? {
            successful.push(path.as_str());
            summary.unchanged += 1;
            progress.indexing(path, (0, 0), (attempt + 1, total), true)?;
            continue;
        }
        storage::invalidate(&mut database.connection, path)?;
        let analysis = if rust {
            Some(
                extract(source::SourceFile {
                    path: source.path.clone(),
                    text: source.text.clone(),
                })
                .with_context(|| format!("cannot analyze source file {path}"))?,
            )
        } else {
            None
        };
        if let Some(analysis) = &analysis {
            for diagnostic in &analysis.diagnostics {
                progress.diagnostic(&format!(
                    "syntax: {path}:{}:{} {}",
                    diagnostic.span.line_start, diagnostic.column, diagnostic.kind
                ))?;
            }
        }
        let chunks = chunk::of(&source);
        let windows = chunks.iter().flat_map(window::of).collect::<Vec<_>>();
        let texts = windows
            .iter()
            .map(|window| window.text.clone())
            .collect::<Vec<_>>();
        if progress.is_terminal() {
            progress.indexing(path, (0, windows.len()), (attempt, total), false)?;
        }
        let vectors = embedder
            .embed_documents(&texts, |completed, count| {
                if progress.is_terminal() {
                    progress.indexing(path, (completed, count), (attempt, total), false)?;
                }
                Ok(())
            })
            .with_context(|| format!("cannot embed source file {path}"))?;
        if let Some(analysis) = &analysis {
            storage::save_file_with_analysis(
                &mut database.connection,
                &source,
                &chunks,
                &windows,
                &vectors,
                Some(analysis),
            )?;
        } else {
            storage::save_file(
                &mut database.connection,
                &source,
                &chunks,
                &windows,
                &vectors,
            )?;
        }
        successful.push(path.as_str());
        summary.indexed += 1;
        progress.indexing(
            path,
            (windows.len(), windows.len()),
            (attempt + 1, total),
            true,
        )?;
    }
    storage::reconcile(&mut database.connection, &successful)?;
    Ok(summary)
}

#[cfg(test)]
#[path = "../../tests/unit/commands/index.rs"]
mod tests;
