//! Bounded read-ahead with ordered, per-file commits. Only this coordinator reads
//! or writes the index. Background jobs contain embedding inputs and vectors.
use std::collections::VecDeque;

use super::*;
use crate::analysis::Analysis;
use crate::embedding::SourceTask;
use crate::profiling::FileScope;
use crate::retrieval::split::Document;
use anyhow::Context;

const PAYLOAD_TARGET: usize = 32 * 1024 * 1024;

struct Prepared {
    task: SourceTask,
    analysis: Analysis,
    documents: Vec<Document>,
}

enum Outcome {
    Skipped(anyhow::Error),
    Reused,
    Changed(anyhow::Result<Box<Prepared>>),
}

struct Pending<'a> {
    // Drop/cancel the job before merging its profiling counters.
    outcome: anyhow::Result<Outcome>,
    profile: Profiler,
    _scope: FileScope,
    path: &'a str,
    ordinal: usize,
    bytes: usize,
}

impl Pending<'_> {
    fn ready(&self) -> bool {
        match &self.outcome {
            Ok(Outcome::Changed(Ok(prepared))) => prepared.task.ready(),
            _ => true,
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn run<'a>(
    root: &Path,
    paths: &'a [String],
    connection: &mut rusqlite::Connection,
    embedder: &mut embedding::Embedder,
    policy: &str,
    progress: &mut Progress<'_>,
    profile: &Profiler,
    summary: &mut Summary,
    read: impl Fn(&Path, &str) -> anyhow::Result<source::SourceFile>,
    extract: impl Fn(source::SourceFile) -> anyhow::Result<Analysis>,
) -> anyhow::Result<Vec<&'a str>> {
    let mut pending = VecDeque::<Pending<'a>>::new();
    let mut bytes = 0usize;
    let mut successful = Vec::new();
    let limit = embedder.pending_files().max(1);
    profile.count("index_queue_file_limit", limit);
    profile.count("index_queue_payload_target_bytes", PAYLOAD_TARGET);
    let result = (|| {
        for (ordinal, path) in paths.iter().enumerate() {
            // The payload threshold stops read-ahead. A single additional file
            // may exceed it, so unusually large files still remain indexable.
            while !pending.is_empty()
                && (pending.len() >= limit
                    || bytes >= PAYLOAD_TARGET
                    || pending.front().unwrap().ready())
            {
                let file = pending.pop_front().unwrap();
                bytes -= file.bytes;
                finish(
                    file,
                    connection,
                    policy,
                    progress,
                    summary,
                    &mut successful,
                    paths.len(),
                )?;
            }
            let (file_profile, scope) = profile.fork_file(path);
            progress.set_profile(file_profile.clone());
            let completed = summary.indexed + summary.unchanged + summary.skipped;
            let outcome = (|| {
                progress.indexing(path, (0, 0), (completed, paths.len()), false)?;
                let source = match file_profile.measure("source_read", || read(root, path)) {
                    Ok(source) => source,
                    Err(error) => return Ok(Outcome::Skipped(error)),
                };
                file_profile.count("files_read", 1);
                file_profile.stage_items("source", 1);
                file_profile.count("source_bytes", source.text.len());
                if file_profile.measure("reuse_check", || {
                    storage::processing::reusable(connection, &source, policy)
                })? {
                    return Ok(Outcome::Reused);
                }
                Ok(Outcome::Changed((|| {
                    let analysis = file_profile
                        .measure("analysis", || extract(source))
                        .with_context(|| format!("cannot analyze source file {path}"))?;
                    for diagnostic in &analysis.diagnostics {
                        progress.diagnostic(&format!(
                            "syntax: {path}:{}:{} {}",
                            diagnostic.span.line_start, diagnostic.column, diagnostic.kind
                        ))?;
                    }
                    file_profile.stage_items("parsing", 1);
                    let documents = file_profile.measure("chunking_token_budget", || {
                        crate::retrieval::ts_v2::documents(&analysis)
                    })?;
                    file_profile.count("documents", documents.len());
                    file_profile.stage_items("windows", documents.len());
                    let texts: Vec<_> = file_profile.measure("document_texts", || {
                        documents.iter().map(|d| d.text.clone()).collect()
                    });
                    if progress.is_terminal() {
                        progress.indexing(
                            path,
                            (0, texts.len()),
                            (completed, paths.len()),
                            false,
                        )?;
                    }
                    let task = embedder
                        .submit_ts_documents(&texts, &file_profile, |done, total| {
                            if progress.is_terminal() {
                                progress.indexing(
                                    path,
                                    (done, total),
                                    (completed, paths.len()),
                                    false,
                                )?;
                            }
                            Ok(())
                        })
                        .with_context(|| format!("cannot embed source file {path}"))?;
                    Ok(Box::new(Prepared {
                        task,
                        analysis,
                        documents,
                    }))
                })()))
            })();
            let failed = matches!(&outcome, Err(_) | Ok(Outcome::Changed(Err(_))));
            let retained = match &outcome {
                Ok(Outcome::Changed(Ok(p))) => {
                    p.analysis.source.text.len()
                        + p.documents.iter().map(|d| d.text.len()).sum::<usize>()
                        + p.task.retained_bytes
                }
                _ => 0,
            };
            bytes += retained;
            pending.push_back(Pending {
                outcome,
                profile: file_profile,
                _scope: scope,
                path,
                ordinal,
                bytes: retained,
            });
            profile.maximum("index_queue_peak_files", pending.len());
            profile.maximum("index_queue_peak_payload_bytes", bytes);
            profile.stage_queue("windows", pending.len(), bytes);
            if failed {
                break;
            }
        }
        while let Some(file) = pending.pop_front() {
            finish(
                file,
                connection,
                policy,
                progress,
                summary,
                &mut successful,
                paths.len(),
            )?;
        }
        Ok(successful)
    })();
    // Pending jobs cancel and wait for their in-flight calls on all error paths.
    drop(pending);
    progress.set_profile(profile.clone());
    result
}

#[allow(clippy::too_many_arguments)]
fn finish<'a>(
    file: Pending<'a>,
    connection: &mut rusqlite::Connection,
    policy: &str,
    progress: &mut Progress<'_>,
    summary: &mut Summary,
    successful: &mut Vec<&'a str>,
    total: usize,
) -> anyhow::Result<()> {
    let Pending {
        outcome,
        profile,
        _scope,
        path,
        ordinal,
        ..
    } = file;
    progress.set_profile(profile.clone());
    match outcome? {
        Outcome::Skipped(error) => {
            progress.diagnostic(&format!("skipped: {error:#}"))?;
            summary.skipped += 1;
            profile.count("files_skipped", 1);
            progress.indexing(path, (0, 0), (ordinal + 1, total), true)?;
        }
        Outcome::Reused => {
            successful.push(path);
            summary.unchanged += 1;
            profile.count("files_reused", 1);
            progress.indexing(path, (0, 0), (ordinal + 1, total), true)?;
        }
        Outcome::Changed(prepared) => {
            // Delay invalidation until this file reaches the commit position.
            // A failure preserves earlier commits and leaves later rows alone.
            profile.measure("invalidation", || storage::invalidate(connection, path))?;
            let Prepared {
                task,
                analysis,
                documents,
            } = *prepared?;
            let vectors = task
                .finish(&profile, |done, count| {
                    if progress.is_terminal() {
                        progress.indexing(path, (done, count), (ordinal, total), false)?;
                    }
                    Ok(())
                })
                .with_context(|| format!("cannot embed source file {path}"))?;
            profile.measure("storage_save", || {
                storage::documents::save(
                    connection,
                    &analysis,
                    storage::documents::Batch {
                        documents: &documents,
                        vectors: &vectors,
                        policy,
                    },
                )
            })?;
            progress.diagnostic(&format!("documents: {path}: {}", documents.len()))?;
            successful.push(path);
            summary.indexed += 1;
            profile.count("files_indexed", 1);
            profile.stage_items("database", 1);
            progress.indexing(
                path,
                (documents.len(), documents.len()),
                (ordinal + 1, total),
                true,
            )?;
        }
    }
    Ok(())
}
