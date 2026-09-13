//! Parser and window preparation own independent workers. File leases bound all
//! active stages, and only the coordinator publishes completed files.
use std::path::Path;
use std::sync::Arc;

use anyhow::{Context, Result, ensure};

use super::{Progress, Summary, admission, channel, walk};
use crate::analysis::Analysis;
use crate::embedding::{SourceTask, WindowPlan, Worker};
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

enum Outcome<T> {
    Reused,
    Skipped(anyhow::Error),
    Changed(Result<T>),
    Failed(anyhow::Error),
}

impl<T> Outcome<T> {
    fn map_changed<U>(self, prepare: impl FnOnce(T) -> Result<U>) -> Outcome<U> {
        match self {
            Self::Reused => Outcome::Reused,
            Self::Skipped(error) => Outcome::Skipped(error),
            Self::Failed(error) => Outcome::Failed(error),
            Self::Changed(result) => Outcome::Changed(result.and_then(prepare)),
        }
    }
}

type Parsed = Outcome<Arc<Analysis>>;
type Prepared = Outcome<Work>;
type Completed = Outcome<Complete>;

struct Work {
    task: SourceTask,
    analysis: Arc<Analysis>,
    documents: Arc<Vec<Document>>,
    plan: WindowPlan,
}

struct Complete {
    analysis: Arc<Analysis>,
    documents: Arc<Vec<Document>>,
    plan: WindowPlan,
    vectors: Result<Arc<Vec<Vec<f32>>>>,
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

enum Stage {
    Discovered,
    Source(Arc<Analysis>),
    Windows(Arc<Vec<Document>>, WindowPlan),
    Vectors(Arc<Vec<Vec<f32>>>),
}

enum Write {
    Stage(Stage, Arc<File>),
    Complete(Message<Completed>),
}

impl File {
    fn key<'a>(&'a self, policy: &'a str) -> storage::staging::Key<'a> {
        storage::staging::Key {
            ordinal: self.ordinal,
            path: &self.path,
            source_hash: &self.source_hash,
            policy,
        }
    }
}

fn stage(send: &channel::Sender<Write>, stage: Stage, file: &Arc<File>) -> bool {
    send.send(Write::Stage(stage, file.clone()), file._permit.bytes())
        .is_ok()
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
    let incremental: bool =
        connection.query_row("SELECT EXISTS(SELECT 1 FROM files)", [], |r| r.get(0))?;
    let cancel = channel::Cancel::default();
    let capacity = workers.saturating_mul(2).max(1);
    let admission = admission::Admission::new(capacity, profile, &cancel);
    let (parsed_tx, parsed_rx) = channel::bounded(capacity, "parsed", profile, &cancel);
    let (ready_tx, ready_rx) = channel::bounded(capacity, "prepared", profile, &cancel);
    let (write_tx, write_rx) = channel::bounded(capacity, "writer", profile, &cancel);
    let (_shutdown_tx, shutdown_rx) =
        channel::bounded::<()>(1, "planner_shutdown", profile, &cancel);
    let mut staging = profile.measure("staging_open", || {
        storage::staging::Store::open(&root.join(".mimirs/staging.db"), profile)
    })?;
    let result = std::thread::scope(|scope| {
        let _stop = cancel.guard();
        let source_writes = write_tx.clone();
        let window_writes = write_tx.clone();
        let parser = scope.spawn(move || {
            if let Err(error) = parse(
                root,
                paths,
                admission,
                &parsed_tx,
                &source_writes,
                policy,
                profile,
            ) {
                let _ = parsed_tx.send(Message::Fatal(error), 0);
            }
        });
        let planner =
            scope.spawn(move || prepare(worker, parsed_rx, ready_tx, window_writes, shutdown_rx));
        let merger = scope.spawn(move || merge(ready_rx, write_tx));
        let result = consume(
            &write_rx,
            connection,
            &mut staging,
            incremental,
            policy,
            progress,
            profile,
            summary,
        );
        cancel.cancel();
        drop(write_rx);
        let joined = [parser.join(), planner.join(), merger.join()];
        if joined.iter().any(Result::is_err) {
            anyhow::bail!("index worker panicked");
        }
        result
    });
    let cleanup = staging.finish();
    match result {
        Ok(paths) => {
            cleanup?;
            Ok(paths)
        }
        Err(error) => {
            cleanup.context(format!(
                "index failed: {error:#}; staging cleanup also failed"
            ))?;
            Err(error)
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn parse(
    root: &Path,
    paths: impl Iterator<Item = Result<walk::stream::Event>>,
    admission: admission::Admission,
    send: &channel::Sender<Message<Parsed>>,
    writer: &channel::Sender<Write>,
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
        let (file_profile, scope) =
            profile.fork_file(&path, crate::analysis::language::for_path(&path).identity);
        let read = file_profile.measure("source_read", || source::read(root, &path));
        let source_hash = if let Ok(source) = &read {
            if !permit.grow(admission::estimate(source.text.len(), path.len())) {
                return Ok(());
            }
            file_profile.count("files_read", 1);
            file_profile.count("source_bytes", source.text.len());
            file_profile.stage_items("source", 1);
            storage::processing::source_hash(&source.text)
        } else {
            String::new()
        };
        let file = Arc::new(File {
            ordinal,
            path,
            source_hash,
            profile: file_profile,
            _scope: scope,
            _permit: permit,
        });
        let parsed = match read {
            Err(error) => Parsed::Skipped(error),
            Ok(source) => match file.profile.measure("reuse_check", || {
                storage::processing::reusable(&reader, &source, policy)
            }) {
                Ok(true) => Parsed::Reused,
                Err(error) => Parsed::Failed(error),
                Ok(false) => {
                    if !stage(writer, Stage::Discovered, &file) {
                        return Ok(());
                    }
                    file.profile.stage_items("parsing", 1);
                    let analysis = file
                        .profile
                        .measure("analysis", || crate::analysis::extract(source))
                        .map(Arc::new)
                        .with_context(|| format!("cannot analyze source file {}", file.path));
                    if let Ok(analysis) = &analysis
                        && !stage(writer, Stage::Source(analysis.clone()), &file)
                    {
                        return Ok(());
                    }
                    Parsed::Changed(analysis)
                }
            },
        };
        let failed = matches!(parsed, Parsed::Failed(_) | Parsed::Changed(Err(_)));
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
    writer: channel::Sender<Write>,
    shutdown: channel::Receiver<()>,
) {
    let mut embedder = worker.into_embedder();
    while let Some(message) = receive.recv() {
        let message = match message {
            Message::File(parsed, file) => {
                let prepared = parsed.map_changed(|analysis| {
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
                    let plan = task.window_plan()?;
                    let documents = Arc::new(documents);
                    ensure!(
                        stage(
                            &writer,
                            Stage::Windows(documents.clone(), plan.clone()),
                            &file
                        ),
                        "index writer closed"
                    );
                    Ok(Work {
                        task,
                        analysis,
                        documents,
                        plan,
                    })
                });
                Message::File(prepared, file)
            }
            Message::WalkError(error) => Message::WalkError(error),
            Message::End(found) => {
                let _ = send.send(Message::End(found), 0);
                drop(send);
                drop(writer);
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
    drop(writer);
    shutdown.recv();
}

fn merge(receive: channel::Receiver<Message<Prepared>>, send: channel::Sender<Write>) {
    while let Some(message) = receive.recv() {
        let message = match message {
            Message::File(prepared, file) => {
                let completed = prepared.map_changed(
                    |Work {
                         task,
                         analysis,
                         documents,
                         plan,
                     }| {
                        let vectors = task
                            .finish(&file.profile, |_, _| Ok(()))
                            .with_context(|| format!("cannot embed source file {}", file.path))
                            .map(Arc::new);
                        if let Ok(vectors) = &vectors {
                            stage(&send, Stage::Vectors(vectors.clone()), &file);
                        }
                        Ok(Complete {
                            analysis,
                            documents,
                            plan,
                            vectors,
                        })
                    },
                );
                Message::File(completed, file)
            }
            Message::WalkError(error) => Message::WalkError(error),
            Message::End(found) => Message::End(found),
            Message::Fatal(error) => Message::Fatal(error),
        };
        let bytes = message.bytes();
        if send.send(Write::Complete(message), bytes).is_err() {
            return;
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn consume(
    receive: &channel::Receiver<Write>,
    connection: &mut rusqlite::Connection,
    staging: &mut storage::staging::Store,
    incremental: bool,
    policy: &str,
    progress: &mut Progress<'_>,
    profile: &Profiler,
    summary: &mut Summary,
) -> Result<Vec<String>> {
    let mut successful = Vec::new();
    let mut stage_errors = std::collections::BTreeMap::new();
    let mut ended = false;
    let result = (|| {
        while let Some(message) = receive.recv() {
            let message = match message {
                Write::Complete(message) => message,
                Write::Stage(stage, file) => {
                    let payload = match &stage {
                        Stage::Discovered => storage::staging::Stage::Discovered,
                        Stage::Source(analysis) => storage::staging::Stage::Source(analysis),
                        Stage::Windows(documents, plan) => {
                            storage::staging::Stage::Windows(documents, plan)
                        }
                        Stage::Vectors(vectors) => storage::staging::Stage::Vectors(vectors),
                    };
                    if let Err(error) = staging.record(&file.key(policy), payload) {
                        stage_errors.entry(file.ordinal).or_insert(error);
                    }
                    continue;
                }
            };
            let (prepared, file) = match message {
                Message::WalkError(error) => {
                    progress.issue(None, &error.to_string());
                    progress.diagnostic(&format!("walk_error: {error}"))?;
                    summary.walk_errors += 1;
                    continue;
                }
                Message::End(found) => {
                    ensure!(found == summary.completed(), "missing completed files");
                    progress.indexing("-", (0, 0), (found, found), true)?;
                    ended = true;
                    continue;
                }
                Message::Fatal(error) => return Err(error),
                Message::File(prepared, file) => (prepared, file),
            };
            ensure!(file.ordinal == summary.completed(), "unordered publication");
            progress.set_profile(file.profile.clone());
            match prepared {
                Completed::Reused => {
                    if let Some(error) = stage_errors.remove(&file.ordinal) {
                        return Err(error);
                    }
                    successful.push(file.path.clone());
                    summary.unchanged += 1;
                    file.profile.count("files_reused", 1);
                }
                Completed::Skipped(error) => {
                    if let Some(error) = stage_errors.remove(&file.ordinal) {
                        return Err(error);
                    }
                    progress.issue(Some(&file.path), &error.to_string());
                    progress.diagnostic(&format!("skipped: {error:#}"))?;
                    summary.skipped += 1;
                    file.profile.count("files_skipped", 1);
                }
                Completed::Failed(error) => return Err(error),
                Completed::Changed(work) => {
                    let published = (|| -> Result<usize> {
                        if let Some(error) = stage_errors.remove(&file.ordinal) {
                            return Err(error);
                        }
                        let Complete {
                            analysis,
                            documents,
                            plan,
                            vectors,
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
                        let vectors = vectors?;
                        ensure!(
                            file.source_hash
                                == storage::processing::source_hash(&analysis.source.text),
                            "source generation changed"
                        );
                        file.profile.measure("staging_validation", || {
                            staging.validate_complete(
                                &file.key(policy),
                                &analysis,
                                &documents,
                                &plan,
                                &vectors,
                            )
                        })?;
                        file.profile.measure("storage_save", || {
                            storage::documents::publish(
                                connection,
                                &analysis,
                                storage::documents::Batch {
                                    documents: &documents,
                                    vectors: &vectors,
                                    policy,
                                },
                            )
                        })?;
                        Ok(documents.len())
                    })();
                    let count = match published {
                        Ok(count) => count,
                        Err(error) => {
                            file.profile.measure("invalidation", || {
                                storage::invalidate(connection, &file.path)
                            })?;
                            return Err(error);
                        }
                    };
                    if incremental {
                        file.profile.measure("writer_cache_release", || {
                            storage::release_writer_cache(connection)
                        })?;
                        file.profile.count("writer_cache_releases", 1);
                    }
                    staging.remove(&file.key(policy))?;
                    progress.diagnostic(&format!("documents: {}: {}", file.path, count))?;
                    successful.push(file.path.clone());
                    summary.indexed += 1;
                    progress.published(&file.path);
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
