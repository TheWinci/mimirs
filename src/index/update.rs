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
use std::{path::Path, time::Duration};
pub(crate) struct Options<'a> {
    pub root: &'a Path,
    pub force: bool,
    pub settle: Option<Duration>,
}
#[derive(Default, Debug, Serialize)]
pub(crate) struct Report {
    #[serde(skip)]
    pub complete: bool,
    #[serde(skip)]
    pub inputs: Option<String>,
    pub selected_source_reads: usize,
    pub analyzed: usize,
    pub embedded_documents: usize,
    pub indexed: usize,
    pub invalidated: usize,
    pub graph_rebuilt: bool,
    pub graph_published: bool,
    pub errors: Vec<String>,
}
#[derive(Default)]
pub(crate) struct Update {
    previous: Option<scan::Scan>,
    database: Vec<Option<crate::files::Stamp>>,
    embedder: Option<Embedder>,
    embedding_policy: Option<String>,
    retry: bool,
}
impl Update {
    pub(crate) fn run(
        &mut self,
        options: Options<'_>,
        make: impl FnOnce() -> Result<Embedder>,
        extract: impl Fn(crate::source::SourceFile) -> Result<analysis::Analysis>,
        status: &mut Option<crate::status::Activity>,
    ) -> Result<Report> {
        let root = options.root;
        let force = options.force;
        let mut report = Report::default();
        if let Some(status) = status {
            status.progress("reconciling", "source", Some("."));
        }
        let observed = scan::Scan::capture(root, force, self.previous.as_ref());
        let source_result = (|| -> Result<()> {
            let (mut scan, reads) = match observed {
                Ok(value) => value,
                Err(error) => {
                    // Selection is unknown. Conservatively retire all searchable
                    // source evidence rather than keep an obsolete subset current.
                    let mut db = storage::open(&root.join(".mimirs/index.db"))?.connection;
                    report.invalidated = indexed_paths(&db)?.len();
                    storage::reconcile(&mut db, &[])?;
                    return Err(error);
                }
            };
            report.selected_source_reads += reads;
            let changed = self
                .previous
                .as_ref()
                .is_none_or(|old| old.key() != scan.key());
            let database_changed = self.database != database_stamp(root);
            if !changed && !database_changed && !force && !self.retry {
                self.previous = Some(scan);
                return Ok(());
            }
            if changed && let Some(delay) = options.settle {
                std::thread::sleep(delay);
                let (settled, reads) = scan::Scan::capture(root, false, Some(&scan))?;
                scan = settled;
                report.selected_source_reads += reads;
            }
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
                let reusable = (|| -> Result<bool> {
                    let Some(policy) = &policy else {
                        return Ok(false);
                    };
                    let Some(saved) = storage::analysis::load(&db, path)? else {
                        return Ok(false);
                    };
                    if file.error.is_some()
                        || !saved.diagnostics.is_empty()
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
            if !changed.is_empty() {
                if self.embedder.is_none() {
                    if let Some(status) = &mut *status {
                        status.progress("preparing model", "vectors_model", None);
                    }
                    let mut model = make.take().unwrap()()?;
                    model.prepare()?;
                    self.embedding_policy =
                        Some(storage::policy::document_policy(&model.token_budget()?));
                    self.embedder = Some(model);
                }
                let model = self.embedder.as_mut().unwrap();
                // Requesting the production tokenizer again would move ownership
                // out of the embedding pool. Its policy is immutable for this engine.
                let current_policy = self.embedding_policy.as_ref().unwrap();
                if policy.as_deref() != Some(current_policy) {
                    report.invalidated += retained.len();
                    storage::policy::configure(&mut db, current_policy)?;
                    changed = scan.files.keys().cloned().collect();
                }
                for path in changed {
                    if let Some(status) = &mut *status {
                        status.progress("indexing", "source", Some(&path));
                    }
                    let result = (|| -> Result<()> {
                        if let Some(error) = &scan.files[&path].error {
                            anyhow::bail!("{error}");
                        }
                        let source = scan.source(root, &path)?;
                        report.selected_source_reads += 1;
                        report.analyzed += 1;
                        if let Some(status) = &mut *status {
                            status.progress("analyzing", "analysis", Some(&path));
                        }
                        let analysis = extract(source)?;
                        ensure!(
                            analysis.diagnostics.is_empty(),
                            "syntax diagnostics prevent complete publication"
                        );
                        let documents = crate::retrieval::ts_v2::documents(&analysis)?;
                        let texts = documents.iter().map(|d| d.text.clone()).collect::<Vec<_>>();
                        if let Some(status) = &mut *status {
                            status.progress("embedding", "vectors_model", Some(&path));
                        }
                        let vectors = model.embed_ts_documents(&texts, |_, _| Ok(()))?;
                        report.embedded_documents += vectors.len();
                        // Verify before committing: source snapshots, facts and
                        // vectors from this file are published in one transaction.
                        if let Some(status) = &mut *status {
                            status.progress("publishing", "source", Some(&path));
                        }
                        scan.source(root, &path)?;
                        report.selected_source_reads += 1;
                        storage::documents::publish(
                            &mut db,
                            &analysis,
                            storage::documents::Batch {
                                documents: &documents,
                                vectors: &vectors,
                                policy: current_policy,
                            },
                        )?;
                        report.indexed += 1;
                        if let Some(status) = &mut *status {
                            status.published(&path);
                        }
                        Ok(())
                    })();
                    if let Err(error) = result {
                        storage::invalidate(&mut db, &path)?;
                        if let Some(status) = &mut *status {
                            status.failed("watch-source", &error.to_string());
                        }
                        report.errors.push(format!("{path}: {error:#}"));
                    }
                }
            }
            // An edit during inference cannot leave the old bytes searchable.
            if let Some(status) = &mut *status {
                status.progress("checking publication", "source", None);
            }
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
                if let Some(status) = &mut *status {
                    status.progress("publishing relationships", "relationships", None);
                }
                (report.graph_rebuilt, report.graph_published) = graph::publish(root, &db, &scan)?;
            }
            self.previous = Some(scan);
            Ok(())
        })();
        if let Err(error) = source_result {
            if let Some(status) = &mut *status {
                status.failed("watch-source", &error.to_string());
            }
            report.errors.push(format!("{error:#}"));
            // A failure can happen while unrelated files are also being edited.
            // Reobserve before returning, even when model preparation failed.
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
                                            crate::files::fingerprint(saved.source.text.as_bytes())
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
        }
        self.retry = !report.errors.is_empty();
        if self.retry {
            remove(root, "relationships.json")?;
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
