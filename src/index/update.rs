//! Reconcile selected source into the derived index and relationship view.
use super::graph;
use crate::{
    analysis,
    embedding::Embedder,
    files::{Stamp, cache::remove, stamp},
    index::scan,
    storage,
};
use anyhow::{Result, ensure};
use serde::Serialize;
use std::path::Path;
pub(crate) struct Options<'a> {
    pub root: &'a Path,
    pub force: bool,
}
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub(crate) enum PhaseOutcome {
    Complete {
        items: Option<usize>,
    },
    Unchanged,
    NotRun,
    Incomplete {
        completed: usize,
        expected: Option<usize>,
        reason: String,
    },
}
impl PhaseOutcome {
    fn failed(reason: impl Into<String>) -> Self {
        Self::Incomplete {
            completed: 0,
            expected: None,
            reason: reason.into(),
        }
    }
}
#[derive(Default, Debug, Serialize)]
pub(crate) struct Report {
    pub components: std::collections::BTreeMap<&'static str, PhaseOutcome>,
    pub source_complete: bool,
    #[serde(skip)]
    pub complete: bool,
    pub checked: bool,
    pub selected: Option<usize>,
    pub graph_validated: bool,
    #[serde(skip)]
    pub inputs: Option<String>,
    pub selected_source_reads: usize,
    pub analyzed: usize,
    pub embedded_documents: usize,
    pub indexed: usize,
    pub unchanged: usize,
    pub recovered: usize,
    pub invalidated: usize,
    pub graph_rebuilt: bool,
    pub graph_published: bool,
    pub warnings: super::diagnostics::Counts,
    pub diagnostics: Option<&'static str>,
    pub errors: Vec<String>,
}
#[derive(Default)]
pub(crate) struct Update {
    previous: Option<scan::Scan>,
    database: Vec<Option<crate::files::Stamp>>,
    embedder: Option<Embedder>,
    worker: Option<crate::embedding::Worker>,
    workers: usize,
    embedding_policy: Option<String>,
    retry: bool,
    warnings: super::diagnostics::Counts,
    diagnostics: Option<&'static str>,
    relationships: Option<PhaseOutcome>,
}
impl Update {
    pub(crate) fn run(
        &mut self,
        options: Options<'_>,
        make: impl FnOnce() -> Result<Embedder>,
        extract: impl Fn(crate::source::SourceFile) -> Result<analysis::Analysis>,
        progress: &mut super::progress::Progress<'_>,
    ) -> Result<Report> {
        let root = options.root;
        let force = options.force;
        let mut report = Report {
            components: [
                "source",
                "analysis",
                "retrieval",
                "embeddings",
                "storage",
                "relationships",
            ]
            .into_iter()
            .map(|name| (name, PhaseOutcome::NotRun))
            .collect(),
            ..Default::default()
        };
        let mut active_phase = "source";
        let mut details_scan = None;
        let mut retirement_attempted = false;
        progress.phase("discovering source", "source", None)?;
        let profile = progress.profile.clone();
        let observed = profile.measure("source_observation", || {
            scan::Scan::capture_progress(
                root,
                force,
                self.previous.as_ref(),
                &profile,
                &mut |phase, path, found| progress.observation(phase, path, found),
            )
        });
        let source_result = (|| -> Result<()> {
            let (scan, reads) = match observed {
                Ok(value) => value,
                Err(error) => {
                    // Selection is unknown. Conservatively retire all searchable
                    // source evidence rather than keep an obsolete subset current.
                    if root.join(".mimirs/index.db").exists() {
                        let mut db = storage::open(&root.join(".mimirs/index.db"))?.connection;
                        report.invalidated = indexed_paths(&db)?.len();
                        storage::reconcile(&mut db, &[])?;
                    }
                    return Err(error);
                }
            };
            report.selected_source_reads += reads;
            report.selected = Some(scan.files.len());
            report.components.insert(
                "source",
                PhaseOutcome::Complete {
                    items: report.selected,
                },
            );
            let changed = self
                .previous
                .as_ref()
                .is_none_or(|old| old.key() != scan.key());
            let database_changed = self.database != database_stamp(root);
            if !changed && !database_changed && !force && !self.retry {
                report.source_complete = true;
                for value in report.components.values_mut() {
                    *value = PhaseOutcome::Unchanged;
                }
                report.warnings = self.warnings.clone();
                report.diagnostics = self.diagnostics;
                report.unchanged = scan.files.len() - self.warnings.unsupported_encoding_files;
                if let Some(phase @ PhaseOutcome::Incomplete { .. }) = &self.relationships {
                    report.components.insert("relationships", phase.clone());
                }
                self.previous = Some(scan);
                return Ok(());
            }
            report.checked = true;
            details_scan = Some(scan.clone());
            progress.walking("-", scan.files.len())?;
            let mut db = storage::open(&root.join(".mimirs/index.db"))?.connection;
            let old_paths = indexed_paths(&db)?;
            if !scan.errors.is_empty() {
                report.invalidated += old_paths.len();
                storage::reconcile(&mut db, &[])?;
                anyhow::bail!(
                    "source/asset discovery incomplete: {}",
                    scan.errors.join("; ")
                );
            }
            let policy = storage::policy::read_for_search(&db).ok().flatten();
            let mut retained = Vec::new();
            let mut changed = Vec::new();
            for (path, file) in &scan.files {
                if file.content == scan::Content::UnsupportedEncoding {
                    continue;
                }
                let reusable = (|| -> Result<bool> {
                    let Some(policy) = &policy else {
                        return Ok(false);
                    };
                    let Some(saved) = storage::analysis::load(&db, path)? else {
                        return Ok(false);
                    };
                    if file.error.is_some()
                        || file.hash.as_deref()
                            != Some(
                                crate::files::fingerprint(saved.source.text.as_bytes()).as_str(),
                            )
                    {
                        return Ok(false);
                    }
                    storage::processing::reusable(&db, &saved.source, policy)
                })()
                .unwrap_or(false);
                if reusable {
                    retained.push(path.as_str());
                } else {
                    changed.push(path.clone());
                }
            }
            report.unchanged = retained.len();
            report.invalidated += old_paths
                .iter()
                .filter(|p| !retained.contains(&p.as_str()))
                .count();
            // Retire every changed/deleted file before any fallible extraction or
            // inference, including files later in the update queue.
            if report.invalidated > 0 {
                storage::reconcile(&mut db, &retained)?;
            }
            let mut make = Some(make);
            if changed.is_empty() {
                for name in ["analysis", "retrieval", "embeddings", "storage"] {
                    report.components.insert(
                        name,
                        if scan.files.is_empty() {
                            PhaseOutcome::Complete { items: Some(0) }
                        } else if retained.is_empty() {
                            PhaseOutcome::NotRun
                        } else {
                            PhaseOutcome::Unchanged
                        },
                    );
                }
            }
            if !changed.is_empty() {
                let config: crate::config::Config = toml::from_str(&scan.config)?;
                let workers = config.resolved_embedding_workers(
                    std::thread::available_parallelism().map_or(1, usize::from),
                );
                if workers != self.workers {
                    self.embedder = None;
                    self.worker = None;
                }
                if self.embedder.is_none() {
                    active_phase = "embeddings";
                    progress.phase("preparing model", "vectors_model", None)?;
                    let mut model = make.take().unwrap()()?
                        .with_workers(workers)
                        .with_profile(progress.profile.clone());
                    model.prepare()?;
                    self.embedding_policy =
                        Some(storage::policy::document_policy(&model.token_budget()?));
                    self.worker = model.take_worker();
                    self.embedder = Some(model);
                    self.workers = workers;
                }
                // Requesting the production tokenizer again would move ownership
                // out of the embedding pool. Its policy is immutable for this engine.
                let current_policy = self.embedding_policy.as_ref().unwrap();
                if policy.as_deref() != Some(current_policy) {
                    active_phase = "storage";
                    report.unchanged = 0;
                    report.invalidated += retained.len();
                    storage::policy::configure(&mut db, current_policy)?;
                    changed = scan
                        .files
                        .iter()
                        .filter(|(_, file)| file.content != scan::Content::UnsupportedEncoding)
                        .map(|(path, _)| path.clone())
                        .collect();
                }
                let selected: std::collections::BTreeSet<_> = changed.into_iter().collect();
                let expected = selected.len();
                active_phase = "pipeline";
                let profile = progress.profile.clone();
                let cancel = crate::channel::Cancel::default();
                let mut ordinal = 0;
                let stream = crate::source::walk::stream::Stream::start(
                    root,
                    &config.selection(),
                    &profile,
                    &cancel,
                )?;
                let paths = stream.filter_map(move |event| match event {
                    Ok(crate::source::walk::stream::Event::Path { path, .. })
                        if selected.contains(&path) =>
                    {
                        let next = ordinal;
                        ordinal += 1;
                        Some(Ok(crate::source::walk::stream::Event::Path {
                            path,
                            ordinal: next,
                        }))
                    }
                    Ok(crate::source::walk::stream::Event::Path { .. }) => None,
                    Ok(crate::source::walk::stream::Event::End { .. }) => {
                        Some(Ok(crate::source::walk::stream::Event::End {
                            found: ordinal,
                        }))
                    }
                    other => Some(other),
                });
                progress.phase("processing source", "source", None)?;
                let mut summary = super::Summary::default();
                let indexed = if self.worker.is_some() {
                    super::parallel::run_warm(
                        root,
                        Box::new(paths),
                        &mut self.worker,
                        workers,
                        &mut db,
                        current_policy,
                        progress,
                        &profile,
                        &mut summary,
                        true,
                    )
                } else {
                    super::pipeline::run(
                        root,
                        paths,
                        None,
                        &mut db,
                        self.embedder.as_mut().unwrap(),
                        current_policy,
                        progress,
                        &profile,
                        &mut summary,
                        crate::source::read,
                        &extract,
                        true,
                    )
                };
                report.selected_source_reads += summary.source_reads;
                report.analyzed += summary.analyzed;
                report.embedded_documents += summary.embedded_documents;
                report.indexed += summary.indexed;
                report.recovered += summary.recovered;
                let reason = indexed
                    .as_ref()
                    .err()
                    .map(|e| format!("{e:#}"))
                    .unwrap_or_else(|| "some selected files did not complete processing".into());
                for (n, name) in ["analysis", "retrieval", "embeddings", "storage"]
                    .into_iter()
                    .enumerate()
                {
                    let ready = summary.ready[n] + summary.unchanged;
                    let items = if matches!(name, "retrieval" | "embeddings") {
                        (report.unchanged == 0 && summary.unchanged == 0)
                            .then_some(summary.documents)
                    } else {
                        Some(ready + report.unchanged)
                    };
                    report.components.insert(
                        name,
                        if ready == expected {
                            PhaseOutcome::Complete { items }
                        } else if ready == 0 && summary.attempted[n] == 0 {
                            PhaseOutcome::NotRun
                        } else {
                            PhaseOutcome::Incomplete {
                                completed: ready + report.unchanged,
                                expected: report.selected,
                                reason: reason.clone(),
                            }
                        },
                    );
                }
                indexed?;
                // Unsupported encodings never entered this work set. These are
                // actual read/discovery failures, including changes during work.
                ensure!(
                    summary.failures.is_empty() && summary.walk_errors == 0,
                    "source processing failed: {}",
                    summary.failures.join("; ")
                );
            }

            active_phase = "source";
            // An edit during inference cannot leave the old bytes searchable.
            progress.phase("checking publication", "source", None)?;
            let (after, reads) = scan::Scan::capture(root, true, None)?;
            report.selected_source_reads += reads;
            if after.key() != scan.key() {
                for path in indexed_paths(&db)? {
                    if after.files.get(&path).map(|f| (&f.hash, &f.error))
                        != scan.files.get(&path).map(|f| (&f.hash, &f.error))
                    {
                        storage::invalidate(&mut db, &path)?;
                        report.invalidated += 1;
                    }
                }
                anyhow::bail!(
                    "source or resolver inputs changed during reconciliation; retry pending"
                );
            }
            if report.errors.is_empty() {
                active_phase = "storage";
                storage::audit(&db)?;
                report.source_complete = true;
                progress.phase("publishing relationships", "relationships", None)?;
                match graph::publish(root, &db, &scan) {
                    Ok((rebuilt, published)) => {
                        report.graph_rebuilt = rebuilt;
                        report.graph_published = published;
                        report.graph_validated = true;
                        report
                            .components
                            .insert("relationships", PhaseOutcome::Complete { items: None });
                    }
                    Err(error) if error.downcast_ref::<graph::IncompleteCoverage>().is_some() => {
                        report
                            .components
                            .insert("relationships", PhaseOutcome::failed(error.to_string()));
                        // Failure to retire old evidence is an I/O failure, not a coverage warning.
                        retirement_attempted = true;
                        if let Err(error) = remove(root, "relationships.json") {
                            report
                                .errors
                                .push(format!("cannot retire relationship cache: {error:#}"));
                        }
                    }
                    Err(error) => {
                        let reason = format!("relationships: {error:#}");
                        report
                            .components
                            .insert("relationships", PhaseOutcome::failed(reason.clone()));
                        report.errors.push(reason);
                    }
                }
            }
            self.previous = Some(scan);
            Ok(())
        })();
        if let Err(error) = source_result {
            if let Some(status) = &mut progress.status {
                status.failed("processing-source", &error.to_string());
            }
            // Record the failed component before changing the visible phase.
            // The original error may be a broken terminal; still finish safety cleanup.
            let _ = progress.phase("checking retained publications", "source", None);
            let reason = format!("{error:#}");
            if active_phase != "pipeline" {
                report
                    .components
                    .insert(active_phase, PhaseOutcome::failed(reason.clone()));
            }
            report.errors.push(reason.clone());
            // Reobserve successful publications before retaining them after failure.
            let cleanup = (|| -> Result<usize> {
                if !root.join(".mimirs/index.db").exists() {
                    return Ok(0);
                }
                let mut db = storage::open(&root.join(".mimirs/index.db"))?.connection;
                let mut keep = Vec::new();
                if let Ok((latest, reads)) = scan::Scan::capture(root, true, None) {
                    report.selected_source_reads += reads;
                    if latest.errors.is_empty() {
                        for path in indexed_paths(&db)? {
                            if let Ok(Some(saved)) = storage::analysis::load(&db, &path)
                                && latest.files.get(&path).is_some_and(|f| {
                                    f.error.is_none()
                                        && f.hash.as_deref()
                                            == Some(
                                                crate::files::fingerprint(
                                                    saved.source.text.as_bytes(),
                                                )
                                                .as_str(),
                                            )
                                })
                            {
                                keep.push(path);
                            }
                        }
                    }
                }
                report.invalidated += indexed_paths(&db)?.len().saturating_sub(keep.len());
                storage::reconcile(
                    &mut db,
                    &keep.iter().map(String::as_str).collect::<Vec<_>>(),
                )?;
                Ok(keep.len())
            })();
            match cleanup {
                Ok(kept)
                    if matches!(report.components["storage"], PhaseOutcome::Complete { .. }) =>
                {
                    report.components.insert(
                        "storage",
                        PhaseOutcome::Incomplete {
                            completed: kept,
                            expected: report.selected,
                            reason,
                        },
                    );
                }
                Ok(_) => {}
                Err(error) => {
                    let reason = format!("publication cleanup: {error:#}");
                    report
                        .components
                        .insert("storage", PhaseOutcome::failed(reason.clone()));
                    report.errors.push(reason);
                }
            }
        }
        if let Some(scan) = details_scan {
            if let Err(error) = progress.phase("saving diagnostics", "source", None) {
                report.errors.push(format!("progress output: {error}"));
            }
            let mut counts = super::diagnostics::Counts::default();
            let details = (|| -> Result<_> {
                let db = storage::open_read_only(&root.join(".mimirs/index.db"))?;
                super::diagnostics::publish(root, &db, &scan, &report.errors, &mut counts)
            })();
            report.warnings = counts.clone();
            match details {
                Ok(()) => {
                    self.warnings = counts;
                    report.diagnostics = Some(super::diagnostics::PATH);
                    self.diagnostics = report.diagnostics;
                }
                Err(error) => report
                    .errors
                    .push(format!("cannot save processing diagnostics: {error:#}")),
            }
        }
        if report.warnings.unsupported_encoding_files > 0 || report.warnings.read_failures > 0 {
            report.components.insert(
                "source",
                PhaseOutcome::Incomplete {
                    completed: report
                        .selected
                        .unwrap_or(0)
                        .saturating_sub(report.warnings.unsupported_encoding_files)
                        .saturating_sub(report.warnings.read_failures),
                    expected: report.selected,
                    reason: if report.warnings.read_failures > 0 {
                        "source read failures; other current publications were retained"
                    } else {
                        "unsupported encoding; readable source was processed"
                    }
                    .into(),
                },
            );
        }
        self.relationships = report.components.get("relationships").cloned();
        self.retry = !report.errors.is_empty();
        if self.retry
            && !report.graph_validated
            && !retirement_attempted
            && let Err(error) = remove(root, "relationships.json")
        {
            report
                .errors
                .push(format!("cannot retire relationship cache: {error:#}"));
        }
        self.database = database_stamp(root);
        report.complete = !self.retry;
        report.inputs = self.previous.as_ref().map(scan::Scan::key);
        Ok(report)
    }
}
pub fn indexed_paths(db: &rusqlite::Connection) -> Result<Vec<String>> {
    Ok(db
        .prepare("SELECT path FROM files ORDER BY path")?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?)
}
pub fn database_stamp(root: &Path) -> Vec<Option<Stamp>> {
    ["index.db", "index.db-wal", "index.db-journal"]
        .map(|p| stamp(&root.join(".mimirs").join(p)).ok())
        .to_vec()
}
