use std::io::{self, IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::profiling::Profiler;
use anyhow::{Context, ensure};

use crate::{config::Config, embedding, source, storage};

mod progress;
mod walk;

use progress::Progress;

pub fn run(report_path: Option<&Path>, cache_dir: Option<PathBuf>) -> anyhow::Result<()> {
    if let Some(path) = report_path {
        ensure!(
            !path.try_exists()?,
            "profile report already exists: {}",
            path.display()
        );
    }
    let profile = report_path.map_or_else(Profiler::default, |_| Profiler::enabled());
    let start = Instant::now();
    let stderr = io::stderr();
    let terminal = stderr.is_terminal();
    let result = run_at_profiled(
        Path::new("."),
        || embedding::production_profiled(cache_dir, profile.clone()),
        &mut io::stdout().lock(),
        &mut stderr.lock(),
        terminal,
        &|| start.elapsed(),
        &profile,
    );
    if let Some(path) = report_path {
        let report = profile
            .finish(result.as_ref().err().map(|e| format!("{e:#}")))
            .expect("enabled profile");
        let saved = (|| -> anyhow::Result<()> {
            let mut output = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(path)?;
            serde_json::to_writer_pretty(&mut output, &report)?;
            writeln!(output)?;
            Ok(())
        })()
        .with_context(|| format!("cannot write profile {}", path.display()));
        return result.and(saved);
    }
    result
}

#[cfg(test)]
fn run_at(
    root: &Path,
    make_embedder: impl FnOnce() -> anyhow::Result<embedding::Embedder>,
    stdout: &mut dyn Write,
    stderr: &mut dyn Write,
    terminal: bool,
    elapsed: &dyn Fn() -> Duration,
) -> anyhow::Result<()> {
    run_at_profiled(
        root,
        make_embedder,
        stdout,
        stderr,
        terminal,
        elapsed,
        &Profiler::default(),
    )
}

fn run_at_profiled(
    root: &Path,
    make_embedder: impl FnOnce() -> anyhow::Result<embedding::Embedder>,
    stdout: &mut dyn Write,
    stderr: &mut dyn Write,
    terminal: bool,
    elapsed: &dyn Fn() -> Duration,
    profile: &Profiler,
) -> anyhow::Result<()> {
    let mut progress = Progress::new(root, stderr, terminal, elapsed).with_profile(profile.clone());
    let result = index_profiled(root, make_embedder, &mut progress, profile);
    // Clear even on failure, before main prints the error.
    let cleared = progress.clear();
    let summary = result?;
    cleared?;
    let _output = profile.scope("progress_output");
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

fn index_profiled(
    root: &Path,
    make_embedder: impl FnOnce() -> anyhow::Result<embedding::Embedder>,
    progress: &mut Progress<'_>,
    profile: &Profiler,
) -> anyhow::Result<Summary> {
    index_with_profiled(
        root,
        make_embedder,
        progress,
        source::read,
        crate::analysis::extract,
        profile,
    )
}

#[cfg(test)]
fn index_with(
    root: &Path,
    make_embedder: impl FnOnce() -> anyhow::Result<embedding::Embedder>,
    progress: &mut Progress<'_>,
    read: impl Fn(&Path, &str) -> anyhow::Result<source::SourceFile>,
    extract: impl Fn(source::SourceFile) -> anyhow::Result<crate::analysis::Analysis>,
) -> anyhow::Result<Summary> {
    index_with_profiled(
        root,
        make_embedder,
        progress,
        read,
        extract,
        &Profiler::default(),
    )
}

fn index_with_profiled(
    root: &Path,
    make_embedder: impl FnOnce() -> anyhow::Result<embedding::Embedder>,
    progress: &mut Progress<'_>,
    read: impl Fn(&Path, &str) -> anyhow::Result<source::SourceFile>,
    extract: impl Fn(source::SourceFile) -> anyhow::Result<crate::analysis::Analysis>,
    profile: &Profiler,
) -> anyhow::Result<Summary> {
    let config = profile.measure("config", || Config::load(root))?;
    progress.walking("-", 0)?;
    let walk = profile.measure("discovery", || {
        walk::discover(root, &config, |file, found| progress.walking(file, found))
    })?;
    profile.count("files_discovered", walk.paths.len());
    for error in &walk.errors {
        progress.diagnostic(&format!("walk_error: {error}"))?;
    }

    let database_path = root.join(".mimirs/index.db");
    let mut database = profile.measure("database_open", || storage::open(&database_path))?;
    if database.outcome != storage::OpenOutcome::Reused {
        progress.diagnostic(&database.outcome.message(&database_path))?;
    }
    let available = std::thread::available_parallelism().map_or(1, usize::from);
    let workers = config.resolved_embedding_workers(available);
    profile.count("embedding_worker_limit", workers);
    let mut embedder = make_embedder()?
        .with_workers(workers)
        .with_profile(profile.clone());
    profile.measure("model_validation", || {
        storage::validate_model(&database.connection)
    })?;
    profile.measure("model_prepare", || embedder.prepare())?;

    let budget = profile.measure("tokenizer_setup", || embedder.token_budget())?;
    let document_policy = storage::policy::document_policy(&budget);
    profile.measure("database_policy", || {
        storage::policy::configure(&mut database.connection, &document_policy)
    })?;

    let mut summary = Summary {
        walk_errors: walk.errors.len(),
        ..Summary::default()
    };
    let mut successful = Vec::new();
    let total = walk.paths.len();
    for (attempt, path) in walk.paths.iter().enumerate() {
        let _file = profile.file(path);
        progress.indexing(path, (0, 0), (attempt, total), false)?;
        let source = match profile.measure("source_read", || read(root, path)) {
            Ok(source) => source,
            Err(error) => {
                progress.diagnostic(&format!("skipped: {error:#}"))?;
                summary.skipped += 1;
                profile.count("files_skipped", 1);
                progress.indexing(path, (0, 0), (attempt + 1, total), true)?;
                continue;
            }
        };
        profile.count("files_read", 1);
        profile.count("source_bytes", source.text.len());
        if profile.measure("reuse_check", || {
            storage::processing::reusable(&database.connection, &source, &document_policy)
        })? {
            successful.push(path.as_str());
            summary.unchanged += 1;
            profile.count("files_reused", 1);
            progress.indexing(path, (0, 0), (attempt + 1, total), true)?;
            continue;
        }
        profile.measure("invalidation", || {
            storage::invalidate(&mut database.connection, path)
        })?;
        let analysis = profile
            .measure("analysis", || extract(source))
            .with_context(|| format!("cannot analyze source file {path}"))?;
        for diagnostic in &analysis.diagnostics {
            progress.diagnostic(&format!(
                "syntax: {path}:{}:{} {}",
                diagnostic.span.line_start, diagnostic.column, diagnostic.kind
            ))?;
        }
        let documents = profile.measure("chunking_token_budget", || {
            crate::retrieval::source::documents(&analysis, &budget)
        })?;
        profile.count("documents", documents.len());
        let texts: Vec<_> = profile.measure("document_texts", || {
            documents.iter().map(|d| d.text.clone()).collect()
        });
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
        profile.measure("storage_save", || {
            storage::documents::save(
                &mut database.connection,
                &analysis,
                storage::documents::Batch {
                    documents: &documents,
                    vectors: &vectors,
                    policy: &document_policy,
                },
            )
        })?;
        progress.diagnostic(&format!("documents: {path}: {}", documents.len()))?;
        successful.push(path.as_str());
        summary.indexed += 1;
        profile.count("files_indexed", 1);
        progress.indexing(path, (texts.len(), texts.len()), (attempt + 1, total), true)?;
    }
    profile.measure("reconciliation", || {
        storage::reconcile(&mut database.connection, &successful)
    })?;
    Ok(summary)
}

#[cfg(test)]
#[path = "../../tests/unit/commands/index.rs"]
mod tests;
