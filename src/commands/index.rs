use std::io::{self, IsTerminal, Write};
use std::path::Path;
use std::time::{Duration, Instant};

use anyhow::Context;

use crate::{config::Config, embedding, source, storage};

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

    let budget = embedder.token_budget()?;
    let document_policy = storage::policy::document_policy(&budget);
    storage::policy::configure(&mut database.connection, &document_policy)?;

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
        if storage::processing::reusable(&database.connection, &source, &document_policy)? {
            successful.push(path.as_str());
            summary.unchanged += 1;
            progress.indexing(path, (0, 0), (attempt + 1, total), true)?;
            continue;
        }
        storage::invalidate(&mut database.connection, path)?;
        let analysis =
            extract(source).with_context(|| format!("cannot analyze source file {path}"))?;
        for diagnostic in &analysis.diagnostics {
            progress.diagnostic(&format!(
                "syntax: {path}:{}:{} {}",
                diagnostic.span.line_start, diagnostic.column, diagnostic.kind
            ))?;
        }
        let documents = crate::retrieval::source::documents(&analysis, &budget)?;
        let texts: Vec<_> = documents.iter().map(|d| d.text.clone()).collect();
        if progress.is_terminal() {
            progress.indexing(path, (0, texts.len()), (attempt, total), false)?;
        }
        let vectors = embedder
            .embed_documents(&texts, |completed, count| {
                if progress.is_terminal() {
                    progress.indexing(path, (completed, count), (attempt, total), false)?;
                }
                Ok(())
            })
            .with_context(|| format!("cannot embed source file {path}"))?;
        storage::documents::save(
            &mut database.connection,
            &analysis,
            storage::documents::Batch {
                documents: &documents,
                vectors: &vectors,
                policy: &document_policy,
            },
        )?;
        progress.diagnostic(&format!("documents: {path}: {}", documents.len()))?;
        successful.push(path.as_str());
        summary.indexed += 1;
        progress.indexing(path, (texts.len(), texts.len()), (attempt + 1, total), true)?;
    }
    storage::reconcile(&mut database.connection, &successful)?;
    Ok(summary)
}

#[cfg(test)]
#[path = "../../tests/unit/commands/index.rs"]
mod tests;
