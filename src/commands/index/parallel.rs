//! Parser and window preparation own independent workers. File leases bound all
//! active stages, and only the coordinator publishes completed files.
use std::path::Path;
use std::sync::Arc;

use anyhow::{Context, Result, ensure};

use super::{Progress, Summary, admission, channel, walk};
use crate::analysis::Analysis;
use crate::embedding::{SourceTask, Worker};
use crate::profiling::{FileScope, Profiler};
use crate::retrieval::split::Document;
use crate::{source, storage};

pub(super) struct File {
    pub ordinal: usize,
    pub path: String,
    pub source_hash: String,
    pub profile: Profiler,
    _scope: FileScope,
    _permit: admission::Permit,
}

enum Parsed {
    Reused,
    Skipped(anyhow::Error),
    Changed(Result<Arc<Analysis>>),
    Failed(anyhow::Error),
}

struct Work {
    task: SourceTask,
    analysis: Arc<Analysis>,
    documents: Arc<Vec<Document>>,
}

enum Prepared {
    Reused,
    Skipped(anyhow::Error),
    Changed(Result<Work>),
    Failed(anyhow::Error),
}

enum Message<T> {
    // Drop/cancel work before the last file profile and admission lease.
    File(T, Arc<File>),
    WalkError(String),
    End(usize),
    Fatal(anyhow::Error),
}

impl<T> Message<T> {
    fn bytes(&self) -> usize {
        match self {
            Self::File(_, file) => file._permit.bytes(),
            _ => 0,
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn run(
    root: &Path,
    paths: Box<dyn Iterator<Item = Result<walk::stream::Event>> + Send>,
    worker: Worker,
    workers: usize,
    connection: &mut rusqlite::Connection,
    policy: &str,
    progress: &mut Progress<'_>,
    profile: &Profiler,
    summary: &mut Summary,
) -> Result<Vec<String>> {
    let cancel = channel::Cancel::default();
    let admission = admission::Admission::new(workers.saturating_mul(2).max(1), profile, &cancel);
    let capacity = workers.saturating_mul(2).max(1);
    let (parsed_tx, parsed_rx) = channel::bounded(capacity, "parsed", profile, &cancel);
    let (ready_tx, ready_rx) = channel::bounded(capacity, "prepared", profile, &cancel);
    let (_shutdown_tx, shutdown_rx) =
        channel::bounded::<()>(1, "planner_shutdown", profile, &cancel);
    std::thread::scope(|scope| {
        let _stop = cancel.guard();
        let parser = scope.spawn(move || {
            if let Err(error) = parse(root, paths, admission, &parsed_tx, policy, profile) {
                let _ = parsed_tx.send(Message::Fatal(error), 0);
            }
        });
        let planner = scope.spawn(move || prepare(worker, parsed_rx, ready_tx, shutdown_rx));
        let result = consume(&ready_rx, connection, policy, progress, profile, summary);
        cancel.cancel();
        drop(ready_rx);
        let joined = [parser.join(), planner.join()];
        if joined.iter().any(Result::is_err) {
            anyhow::bail!("index worker panicked");
        }
        result
    })
}

fn parse(
    root: &Path,
    paths: impl Iterator<Item = Result<walk::stream::Event>>,
    admission: admission::Admission,
    send: &channel::Sender<Message<Parsed>>,
    policy: &str,
    profile: &Profiler,
) -> Result<()> {
    let reader = storage::index_reader(&root.join(".mimirs/index.db"))?;
    for event in paths {
        let (path, ordinal) = match event? {
            walk::stream::Event::Path { path, ordinal } => (path, ordinal),
            walk::stream::Event::Error(error) => {
                if send.send(Message::WalkError(error), 0).is_err() {
                    return Ok(());
                }
                continue;
            }
            walk::stream::Event::End { found } => {
                let _ = send.send(Message::End(found), 0);
                return Ok(());
            }
        };
        let estimate = std::fs::metadata(root.join(&path)).map_or(0, |m| m.len() as usize);
        let Some(mut permit) = admission.acquire(admission::estimate(estimate, path.len())) else {
            return Ok(());
        };
        let (file_profile, scope) = profile.fork_file(&path);
        let read = file_profile.measure("source_read", || source::read(root, &path));
        let mut source_hash = String::new();
        let parsed = match read {
            Err(error) => Parsed::Skipped(error),
            Ok(source) => {
                if !permit.grow(admission::estimate(source.text.len(), path.len())) {
                    return Ok(());
                }
                source_hash = storage::processing::source_hash(&source.text);
                file_profile.count("files_read", 1);
                file_profile.count("source_bytes", source.text.len());
                file_profile.stage_items("source", 1);
                match file_profile.measure("reuse_check", || {
                    storage::processing::reusable(&reader, &source, policy)
                }) {
                    Ok(true) => Parsed::Reused,
                    Err(error) => Parsed::Failed(error),
                    Ok(false) => {
                        file_profile.stage_items("parsing", 1);
                        Parsed::Changed(
                            file_profile
                                .measure("analysis", || crate::analysis::extract(source))
                                .map(Arc::new)
                                .with_context(|| format!("cannot analyze source file {path}")),
                        )
                    }
                }
            }
        };
        let failed = matches!(parsed, Parsed::Failed(_) | Parsed::Changed(Err(_)));
        let file = Arc::new(File {
            ordinal,
            path,
            source_hash,
            profile: file_profile,
            _scope: scope,
            _permit: permit,
        });
        let message = Message::File(parsed, file);
        let bytes = message.bytes();
        if send.send(message, bytes).is_err() || failed {
            return Ok(());
        }
    }
    anyhow::bail!("discovery ended without a completion record")
}

fn prepare(
    worker: Worker,
    receive: channel::Receiver<Message<Parsed>>,
    send: channel::Sender<Message<Prepared>>,
    shutdown: channel::Receiver<()>,
) {
    let mut embedder = worker.into_embedder();
    while let Some(message) = receive.recv() {
        let message = match message {
            Message::File(parsed, file) => {
                let prepared = match parsed {
                    Parsed::Reused => Prepared::Reused,
                    Parsed::Skipped(error) => Prepared::Skipped(error),
                    Parsed::Failed(error) => Prepared::Failed(error),
                    Parsed::Changed(analysis) => Prepared::Changed((|| {
                        let analysis = analysis?;
                        let documents = file.profile.measure("chunking_token_budget", || {
                            crate::retrieval::ts_v2::documents(&analysis)
                        })?;
                        file.profile.count("documents", documents.len());
                        file.profile.stage_items("windows", documents.len());
                        let texts = file.profile.measure("document_texts", || {
                            documents.iter().map(|d| d.text.clone()).collect::<Vec<_>>()
                        });
                        let task = embedder
                            .submit_ts_documents(&texts, &file.profile, |_, _| Ok(()))
                            .with_context(|| format!("cannot embed source file {}", file.path))?;
                        Ok(Work {
                            task,
                            analysis,
                            documents: Arc::new(documents),
                        })
                    })()),
                };
                Message::File(prepared, file)
            }
            Message::WalkError(error) => Message::WalkError(error),
            Message::End(found) => {
                let _ = send.send(Message::End(found), 0);
                drop(send);
                // Keep the inference pool alive until its queued tasks drain.
                shutdown.recv();
                return;
            }
            Message::Fatal(error) => Message::Fatal(error),
        };
        let bytes = message.bytes();
        if send.send(message, bytes).is_err() {
            return;
        }
    }
    drop(send);
    shutdown.recv();
}

fn consume(
    receive: &channel::Receiver<Message<Prepared>>,
    connection: &mut rusqlite::Connection,
    policy: &str,
    progress: &mut Progress<'_>,
    profile: &Profiler,
    summary: &mut Summary,
) -> Result<Vec<String>> {
    let mut successful = Vec::new();
    let mut ended = false;
    let result = (|| {
        while let Some(message) = receive.recv() {
            let (prepared, file) = match message {
                Message::WalkError(error) => {
                    progress.diagnostic(&format!("walk_error: {error}"))?;
                    summary.walk_errors += 1;
                    continue;
                }
                Message::End(found) => {
                    ensure!(
                        found == summary.indexed + summary.unchanged + summary.skipped,
                        "missing completed files"
                    );
                    progress.indexing("-", (0, 0), (found, found), true)?;
                    ended = true;
                    continue;
                }
                Message::Fatal(error) => return Err(error),
                Message::File(prepared, file) => (prepared, file),
            };
            ensure!(
                file.ordinal == summary.indexed + summary.unchanged + summary.skipped,
                "unordered publication"
            );
            progress.set_profile(file.profile.clone());
            match prepared {
                Prepared::Reused => {
                    successful.push(file.path.clone());
                    summary.unchanged += 1;
                    file.profile.count("files_reused", 1);
                }
                Prepared::Skipped(error) => {
                    progress.diagnostic(&format!("skipped: {error:#}"))?;
                    summary.skipped += 1;
                    file.profile.count("files_skipped", 1);
                }
                Prepared::Failed(error) => return Err(error),
                Prepared::Changed(work) => {
                    file.profile.measure("invalidation", || {
                        storage::invalidate(connection, &file.path)
                    })?;
                    let Work {
                        task,
                        analysis,
                        documents,
                    } = work?;
                    for diagnostic in &analysis.diagnostics {
                        progress.diagnostic(&format!(
                            "syntax: {}:{}:{} {}",
                            file.path,
                            diagnostic.span.line_start,
                            diagnostic.column,
                            diagnostic.kind
                        ))?;
                    }
                    let vectors = task
                        .finish(&file.profile, |done, count| {
                            if progress.is_terminal() {
                                progress.indexing(
                                    &file.path,
                                    (done, count),
                                    (file.ordinal, usize::MAX),
                                    false,
                                )?;
                            }
                            Ok(())
                        })
                        .with_context(|| format!("cannot embed source file {}", file.path))?;
                    ensure!(
                        file.source_hash == storage::processing::source_hash(&analysis.source.text),
                        "source generation changed"
                    );
                    file.profile.measure("storage_save", || {
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
                    progress.diagnostic(&format!(
                        "documents: {}: {}",
                        file.path,
                        documents.len()
                    ))?;
                    successful.push(file.path.clone());
                    summary.indexed += 1;
                    file.profile.count("files_indexed", 1);
                    file.profile.stage_items("database", 1);
                }
            }
            progress.indexing(&file.path, (0, 0), (file.ordinal + 1, usize::MAX), true)?;
        }
        ensure!(ended, "index pipeline ended before completion");
        Ok(successful)
    })();
    progress.set_profile(profile.clone());
    result
}
