//! Async stages exchange unbounded messages. Blocking work runs outside the
//! async scheduler; only the coordinator publishes completed files.
use std::path::Path;
use std::sync::Arc;

use anyhow::{Context, Result, ensure};

use super::{Progress, Summary, admission, channel, walk};
use crate::analysis::Analysis;
use crate::embedding::{SourceTask, WindowPlan, Worker};
use crate::profiling::{FileScope, Profiler};
use crate::retrieval::split::Document;
use crate::{source, storage};

#[derive(Default)]
struct Metrics {
    ready: [std::sync::atomic::AtomicUsize; 3],
    attempted: [std::sync::atomic::AtomicUsize; 3],
    documents: std::sync::atomic::AtomicUsize,
    reads: std::sync::atomic::AtomicUsize,
    analyzed: std::sync::atomic::AtomicUsize,
    embedded: std::sync::atomic::AtomicUsize,
}
use std::sync::atomic::Ordering::Relaxed;

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

type Parsed = Outcome<(Arc<Analysis>, Option<storage::staging::Recovered>)>;
type Prepared = Outcome<Work>;
type Completed = Outcome<Complete>;

struct Work {
    task: SourceTask,
    recovered: bool,
    analysis: Arc<Analysis>,
    documents: Arc<Vec<Document>>,
    plan: WindowPlan,
}

struct Complete {
    analysis: Arc<Analysis>,
    documents: Arc<Vec<Document>>,
    plan: WindowPlan,
    vectors: Result<Arc<Vec<Vec<f32>>>>,
    recovered: bool,
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
    DiscoveredTotal(usize),
    Progress {
        file: Arc<File>,
        done: usize,
        total: usize,
    },
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

fn embedding_progress(
    send: &channel::Sender<Write>,
    file: &Arc<File>,
    done: usize,
    total: usize,
) -> Result<()> {
    // Progress shares the unbounded writer channel with staged results.
    ensure!(
        send.send(
            Write::Progress {
                file: file.clone(),
                done,
                total
            },
            0
        )
        .is_ok(),
        "index writer closed"
    );
    Ok(())
}

#[allow(clippy::too_many_arguments)]
#[cfg(test)]
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
    let mut slot = Some(worker);
    run_warm(
        root, paths, &mut slot, workers, connection, policy, progress, profile, summary, false,
    )
}

#[allow(clippy::too_many_arguments)]
pub(super) fn run_warm(
    root: &Path,
    paths: Box<dyn Iterator<Item = Result<walk::stream::Event>> + Send>,
    worker_slot: &mut Option<Worker>,
    workers: usize,
    connection: &mut rusqlite::Connection,
    policy: &str,
    progress: &mut Progress<'_>,
    profile: &Profiler,
    summary: &mut Summary,
    verify_current: bool,
) -> Result<Vec<String>> {
    let worker = worker_slot.take().context("missing warm index worker")?;
    let incremental: bool =
        connection.query_row("SELECT EXISTS(SELECT 1 FROM files)", [], |r| r.get(0))?;
    let cancel = channel::Cancel::default();
    let admission = admission::Admission::new(profile, &cancel);
    let (parsed_tx, parsed_rx) = channel::unbounded("parsed", profile, &cancel);
    let (ready_tx, ready_rx) = channel::unbounded("prepared", profile, &cancel);
    let (write_tx, mut write_rx) = channel::unbounded("writer", profile, &cancel);
    let (_shutdown_tx, shutdown_rx) =
        channel::unbounded::<()>("planner_shutdown", profile, &cancel);
    let mut staging = profile.measure("staging_open", || {
        storage::staging::Store::open_for(&root.join(".mimirs/staging.db"), profile, verify_current)
    })?;
    let metrics = Arc::new(Metrics::default());
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(workers.max(2))
        .build()
        .context("cannot start index runtime")?;
    let result = runtime.block_on(async {
        let _stop = cancel.guard();
        let source_writes = write_tx.clone();
        let window_writes = write_tx.clone();
        let parser_root = root.to_owned();
        let parser_policy = policy.to_owned();
        let parser_profile = profile.clone();
        let counters = metrics.clone();
        let parser = tokio::spawn(async move {
            if let Err(error) = parse(
                &parser_root,
                paths,
                admission,
                &parsed_tx,
                &source_writes,
                &parser_policy,
                &parser_profile,
                verify_current,
                &counters,
            )
            .await
            {
                let _ = parsed_tx.send(Message::Fatal(error), 0);
            }
        });
        let planner = tokio::spawn(prepare(
            worker,
            parsed_rx,
            ready_tx,
            window_writes,
            shutdown_rx,
            metrics.clone(),
        ));
        let merger = tokio::spawn(merge(ready_rx, write_tx, metrics.clone()));
        let result = consume(
            &mut write_rx,
            connection,
            &mut staging,
            incremental,
            policy,
            progress,
            profile,
            summary,
            verify_current.then_some(root),
        )
        .await;
        cancel.cancel();
        tokio::task::block_in_place(|| drop(write_rx));
        let (parsed, planned, merged) = tokio::join!(parser, planner, merger);
        if parsed.is_err() || planned.is_err() || merged.is_err() {
            anyhow::bail!("index worker panicked");
        }
        *worker_slot = planned.unwrap();
        result
    });
    for n in 0..3 {
        summary.ready[n] += metrics.ready[n].load(Relaxed);
        summary.attempted[n] += metrics.attempted[n].load(Relaxed);
    }
    summary.documents += metrics.documents.load(Relaxed);
    summary.source_reads += metrics.reads.load(Relaxed);
    summary.analyzed += metrics.analyzed.load(Relaxed);
    summary.embedded_documents += metrics.embedded.load(Relaxed);
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
async fn parse(
    root: &Path,
    mut paths: Box<dyn Iterator<Item = Result<walk::stream::Event>> + Send>,
    admission: admission::Admission,
    send: &channel::Sender<Message<Parsed>>,
    writer: &channel::Sender<Write>,
    policy: &str,
    profile: &Profiler,
    recover: bool,
    metrics: &Metrics,
) -> Result<()> {
    let reader =
        tokio::task::block_in_place(|| storage::index_reader(&root.join(".mimirs/index.db")))?;
    loop {
        let (returned_paths, event) = tokio::task::spawn_blocking(move || {
            let event = paths.next();
            (paths, event)
        })
        .await
        .context("file discovery worker panicked")?;
        paths = returned_paths;
        let Some(event) = event else { break };
        let keep_going = tokio::task::block_in_place(|| -> Result<bool> {
            let (path, ordinal) = match event? {
                walk::stream::Event::Path { path, ordinal } => (path, ordinal),
                walk::stream::Event::Error(error) => {
                    if send.send(Message::WalkError(error), 0).is_err() {
                        return Ok(false);
                    }
                    return Ok(true);
                }
                walk::stream::Event::End { found } => {
                    let _ = writer.send(Write::DiscoveredTotal(found), 0);
                    let _ = send.send(Message::End(found), 0);
                    return Ok(false);
                }
            };
            let estimate = std::fs::metadata(root.join(&path)).map_or(0, |m| m.len() as usize);
            let Some(mut permit) = admission.acquire(admission::estimate(estimate, path.len()))
            else {
                return Ok(false);
            };
            let (file_profile, scope) =
                profile.fork_file(&path, crate::analysis::language::for_path(&path).identity);
            metrics.reads.fetch_add(1, Relaxed);
            let read = file_profile.measure("source_read", || source::read(root, &path));
            let source_hash = if let Ok(source) = &read {
                if !permit.grow(admission::estimate(source.text.len(), path.len())) {
                    return Ok(false);
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
                            return Ok(false);
                        }
                        metrics.attempted[0].fetch_add(1, Relaxed);
                        let cached = recover
                            .then(|| {
                                storage::staging::recover(
                                    root,
                                    &file.path,
                                    &file.source_hash,
                                    policy,
                                )
                            })
                            .flatten();
                        let analysis = if let Some(cached) = &cached {
                            file.profile.count("staging_reused_files", 1);
                            Ok(cached.analysis.clone())
                        } else {
                            metrics.analyzed.fetch_add(1, Relaxed);
                            file.profile.stage_items("parsing", 1);
                            file.profile
                                .measure("analysis", || crate::analysis::extract(source))
                                .map(Arc::new)
                                .with_context(|| {
                                    format!("cannot analyze source file {}", file.path)
                                })
                        };
                        if analysis.is_ok() {
                            metrics.ready[0].fetch_add(1, Relaxed);
                        }
                        if let Ok(analysis) = &analysis
                            && !stage(writer, Stage::Source(analysis.clone()), &file)
                        {
                            return Ok(false);
                        }
                        Parsed::Changed(analysis.map(|a| (a, cached)))
                    }
                },
            };
            let failed = matches!(parsed, Parsed::Failed(_) | Parsed::Changed(Err(_)));
            let message = Message::File(parsed, file);
            let bytes = message.bytes();
            if send.send(message, bytes).is_err() || failed {
                return Ok(false);
            }
            Ok(true)
        })?;
        if !keep_going {
            return Ok(());
        }
    }
    anyhow::bail!("discovery ended without a completion record")
}

async fn prepare(
    mut worker: Worker,
    mut receive: channel::Receiver<Message<Parsed>>,
    send: channel::Sender<Message<Prepared>>,
    writer: channel::Sender<Write>,
    mut shutdown: channel::Receiver<()>,
    metrics: Arc<Metrics>,
) -> Option<Worker> {
    while let Some(message) = receive.recv().await {
        let message = match message {
            Message::File(parsed, file) => {
                let prepared = tokio::task::block_in_place(|| {
                    parsed.map_changed(|(analysis, cached)| {
                        metrics.attempted[1].fetch_add(1, Relaxed);
                        if let Some(cached) = cached {
                            metrics.ready[1].fetch_add(1, Relaxed);
                            metrics.documents.fetch_add(cached.documents.len(), Relaxed);
                            metrics.attempted[2].fetch_add(1, Relaxed);
                            let documents = Arc::new(cached.documents);
                            ensure!(
                                stage(
                                    &writer,
                                    Stage::Windows(documents.clone(), cached.plan.clone()),
                                    &file
                                ),
                                "index writer closed"
                            );
                            return Ok(Work {
                                task: SourceTask::completed(cached.vectors),
                                recovered: true,
                                analysis,
                                documents,
                                plan: cached.plan,
                            });
                        }
                        let documents = file.profile.measure("chunking_token_budget", || {
                            crate::retrieval::ts_v2::documents(&analysis)
                        })?;
                        metrics.ready[1].fetch_add(1, Relaxed);
                        metrics.documents.fetch_add(documents.len(), Relaxed);
                        file.profile.count("documents", documents.len());
                        file.profile.stage_items("windows", documents.len());
                        let texts = file.profile.measure("document_texts", || {
                            documents.iter().map(|d| d.text.clone()).collect::<Vec<_>>()
                        });
                        embedding_progress(&writer, &file, 0, texts.len())?;
                        metrics.attempted[2].fetch_add(1, Relaxed);
                        let task = worker
                            .submit_ts_documents(&texts, &file.profile, |done, total| {
                                embedding_progress(&writer, &file, done, total)
                            })
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
                            recovered: false,
                            task,
                            analysis,
                            documents,
                            plan,
                        })
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
                shutdown.recv().await;
                return Some(worker);
            }
            Message::Fatal(error) => Message::Fatal(error),
        };
        let bytes = message.bytes();
        if send.send(message, bytes).is_err() {
            return Some(worker);
        }
    }
    drop(send);
    drop(writer);
    shutdown.recv().await;
    Some(worker)
}

async fn merge(
    mut receive: channel::Receiver<Message<Prepared>>,
    send: channel::Sender<Write>,
    metrics: Arc<Metrics>,
) {
    while let Some(message) = receive.recv().await {
        if let Message::File(Prepared::Changed(Ok(work)), file) = &message {
            let _wait = file
                .profile
                .stage("inference_completion", crate::profiling::Activity::Input);
            work.task.wait_ready().await;
        }
        let message = tokio::task::block_in_place(|| match message {
            Message::File(prepared, file) => {
                let completed = prepared.map_changed(
                    |Work {
                         task,
                         recovered,
                         analysis,
                         documents,
                         plan,
                     }| {
                        let vectors = task
                            .finish(&file.profile, |done, total| {
                                embedding_progress(&send, &file, done, total)
                            })
                            .with_context(|| format!("cannot embed source file {}", file.path))
                            .map(Arc::new);
                        if let Ok(vectors) = &vectors {
                            metrics.ready[2].fetch_add(1, Relaxed);
                            if !recovered {
                                metrics.embedded.fetch_add(vectors.len(), Relaxed);
                            }
                            stage(&send, Stage::Vectors(vectors.clone()), &file);
                        }
                        Ok(Complete {
                            recovered,
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
        });
        let bytes = message.bytes();
        if send.send(Write::Complete(message), bytes).is_err() {
            return;
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn consume(
    receive: &mut channel::Receiver<Write>,
    connection: &mut rusqlite::Connection,
    staging: &mut storage::staging::Store,
    incremental: bool,
    policy: &str,
    progress: &mut Progress<'_>,
    profile: &Profiler,
    summary: &mut Summary,
    root: Option<&Path>,
) -> Result<Vec<String>> {
    let mut successful = Vec::new();
    let mut stage_errors = std::collections::BTreeMap::new();
    let mut ended = false;
    let mut total = usize::MAX;
    let mut active = std::collections::BTreeMap::<usize, (String, super::progress::Work)>::new();
    let result = async {
        while let Some(message) = receive.recv().await {
            tokio::task::block_in_place(|| -> Result<()> {
                let message = match message {
                    Write::DiscoveredTotal(found) => {
                        total = found;
                        if let Some((path, work)) = active.values().next() {
                            progress.file(
                                path,
                                *work,
                                (summary.completed(), total),
                                super::progress::FileOutcome::Processing,
                            )?;
                        }
                        return Ok(());
                    }
                    Write::Complete(message) => message,
                    Write::Progress {
                        file,
                        done,
                        total: documents,
                    } => {
                        active.insert(
                            file.ordinal,
                            (
                                file.path.clone(),
                                super::progress::Work::Known {
                                    done,
                                    total: documents,
                                },
                            ),
                        );
                        progress.file(
                            &file.path,
                            super::progress::Work::Known {
                                done,
                                total: documents,
                            },
                            (summary.completed(), total),
                            super::progress::FileOutcome::Processing,
                        )?;
                        return Ok(());
                    }
                    Write::Stage(stage, file) => {
                        if matches!(stage, Stage::Discovered) {
                            active.entry(file.ordinal).or_insert_with(|| {
                                (file.path.clone(), super::progress::Work::Unknown)
                            });
                            progress.file(
                                &file.path,
                                super::progress::Work::Unknown,
                                (summary.completed(), total),
                                super::progress::FileOutcome::Processing,
                            )?;
                        }
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
                        return Ok(());
                    }
                };
                let (prepared, file) = match message {
                    Message::WalkError(error) => {
                        progress.issue(None, &error.to_string());
                        progress.diagnostic(&format!("walk_error: {error}"))?;
                        summary.failures.push(format!("discovery: {error}"));
                        summary.walk_errors += 1;
                        return Ok(());
                    }
                    Message::End(found) => {
                        ensure!(found == summary.completed(), "missing completed files");
                        progress.source_complete(found)?;
                        ended = true;
                        return Ok(());
                    }
                    Message::Fatal(error) => return Err(error),
                    Message::File(prepared, file) => (prepared, file),
                };
                ensure!(file.ordinal == summary.completed(), "unordered publication");
                progress.set_profile(file.profile.clone());
                let mut outcome = super::progress::FileOutcome::Published;
                let mut documents = super::progress::Work::NotApplicable;
                match prepared {
                    Completed::Reused => {
                        if let Some(error) = stage_errors.remove(&file.ordinal) {
                            return Err(error);
                        }
                        successful.push(file.path.clone());
                        summary.unchanged += 1;
                        outcome = super::progress::FileOutcome::Reused;
                        file.profile.count("files_reused", 1);
                    }
                    Completed::Skipped(error) => {
                        if let Some(error) = stage_errors.remove(&file.ordinal) {
                            return Err(error);
                        }
                        progress.issue(Some(&file.path), &error.to_string());
                        progress.diagnostic(&format!("skipped: {error:#}"))?;
                        summary.failures.push(format!("{}: {error:#}", file.path));
                        summary.skipped += 1;
                        outcome = super::progress::FileOutcome::Skipped;
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
                                recovered,
                            } = work?;
                            if recovered {
                                summary.recovered += 1;
                                outcome = super::progress::FileOutcome::Recovered;
                            }
                            for diagnostic in &analysis.diagnostics {
                                progress.syntax(&file.path, diagnostic)?;
                            }
                            let vectors = vectors?;
                            summary.attempted[3] += 1;
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
                            if let Some(root) = root {
                                summary.source_reads += 1;
                                super::check_publication(root, &analysis)?;
                            }
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
                        documents = super::progress::Work::Known {
                            done: count,
                            total: count,
                        };
                        if count == 0 {
                            outcome = super::progress::FileOutcome::Empty;
                        }
                        successful.push(file.path.clone());
                        summary.indexed += 1;
                        summary.ready[3] += 1;
                        progress.published(&file.path);
                        file.profile.count("files_indexed", 1);
                        file.profile.stage_items("database", 1);
                    }
                }
                progress.file(&file.path, documents, (file.ordinal + 1, total), outcome)?;
                active.remove(&file.ordinal);
                if let Some((path, work)) = active.values().next() {
                    progress.file(
                        path,
                        *work,
                        (summary.completed(), total),
                        super::progress::FileOutcome::Processing,
                    )?;
                }
                Ok(())
            })?;
        }
        ensure!(ended, "index pipeline ended before completion");
        Ok(successful)
    }
    .await;
    progress.set_profile(profile.clone());
    result
}
