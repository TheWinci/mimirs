//! Complete processing under one writer lease. Callers own scheduling and presentation.
use crate::{
    analysis,
    embedding::Embedder,
    files::cache::{persist, remove},
    knowledge::observation as knowledge,
};
use anyhow::Result;
use serde::Serialize;
use serde_json::json;
use std::path::Path;
pub(crate) struct Request<'a> {
    pub root: &'a Path,
    pub knowledge: &'a knowledge::Options,
    pub force: bool,
}
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub(crate) enum Outcome {
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
    Unconfigured,
    Failed {
        reason: String,
    },
}
#[derive(Default, Debug, Serialize)]
pub(crate) struct ProcessingResult {
    pub components: std::collections::BTreeMap<&'static str, Outcome>,
    pub selected_source_reads: usize,
    pub knowledge_support_reads: usize,
    pub knowledge_journal_replays: usize,
    pub analyzed: usize,
    pub embedded_documents: usize,
    pub indexed: usize,
    pub unchanged: usize,
    pub recovered: usize,
    pub invalidated: usize,
    pub graph_rebuilt: bool,
    pub graph_published: bool,
    pub knowledge_assessed: bool,
    pub knowledge_published: bool,
    pub state_published: bool,
    pub warnings: crate::index::diagnostics::Counts,
    pub diagnostics: Option<&'static str>,
    pub errors: Vec<String>,
}
impl ProcessingResult {
    pub(crate) fn write_summary(&self, output: &mut dyn std::io::Write) -> std::io::Result<()> {
        writeln!(
            output,
            "result: {}",
            if !self.errors.is_empty() {
                "failed"
            } else if self.warnings.any() {
                "complete with warnings"
            } else {
                "complete"
            }
        )?;
        writeln!(
            output,
            "indexed: {} files\nreused: {} files",
            self.indexed, self.unchanged
        )?;
        writeln!(
            output,
            "skipped: {} unsupported-encoding files",
            self.warnings.unsupported_encoding_files
        )?;
        writeln!(
            output,
            "parser diagnostics: {} in {} files",
            self.warnings.parser_diagnostics, self.warnings.parser_files
        )?;
        let graph = match self.components.get("relationships") {
            Some(Outcome::Complete { .. }) => "complete",
            Some(Outcome::Unchanged) => "unchanged",
            Some(Outcome::Incomplete { .. }) => "incomplete",
            _ => "unavailable",
        };
        writeln!(output, "relationships: {graph}")?;
        if let Some(path) = self.diagnostics {
            writeln!(output, "details: {path}")?;
        }
        if self.warnings.omitted_details > 0 {
            writeln!(
                output,
                "details omitted: {} (counts include all diagnostics)",
                self.warnings.omitted_details
            )?;
        }
        if self.warnings.read_failures > 0 {
            writeln!(
                output,
                "read failures: {} files",
                self.warnings.read_failures
            )?;
        }
        if !self.errors.is_empty() {
            writeln!(output, "errors: {}", self.errors.len())?;
            for error in self.errors.iter().take(5) {
                writeln!(
                    output,
                    "error: {}",
                    crate::index::progress::plain(crate::files::preview(error, 300))
                )?;
            }
        }
        Ok(())
    }
}
#[derive(Default)]
pub(crate) struct Session {
    source: crate::index::update::Update,
    knowledge: knowledge::Watcher,
}
impl Session {
    pub(crate) fn process(
        &mut self,
        request: Request<'_>,
        make: impl FnOnce() -> Result<Embedder>,
        extract: impl Fn(crate::source::SourceFile) -> Result<analysis::Analysis>,
        progress: &mut crate::index::progress::Progress<'_>,
    ) -> Result<ProcessingResult> {
        progress.concise();
        if let Some(status) = &mut progress.status {
            status.defer_warnings();
            status.completion(&[]);
        }
        let canonical = request.root.canonicalize()?;
        let root = canonical.as_path();
        let force = request.force;
        // Ownership still covers observation, invalidation and both publications.
        progress.phase("waiting for writer", "source", None)?;
        let _lock = crate::storage::writer::acquire(root)?;
        let source = self
            .source
            .run(
                crate::index::update::Options { root, force },
                make,
                extract,
                progress,
            )
            .unwrap_or_else(|error| crate::index::update::Report {
                errors: vec![format!("{error:#}")],
                ..Default::default()
            });
        let complete = source.source_complete;
        let inputs = source.inputs;
        let mut report = ProcessingResult {
            selected_source_reads: source.selected_source_reads,
            analyzed: source.analyzed,
            embedded_documents: source.embedded_documents,
            indexed: source.indexed,
            unchanged: source.unchanged,
            recovered: source.recovered,
            invalidated: source.invalidated,
            graph_rebuilt: source.graph_rebuilt,
            graph_published: source.graph_published,
            warnings: source.warnings,
            diagnostics: source.diagnostics,
            errors: source.errors,
            ..Default::default()
        };
        for (component, outcome) in source.components {
            use crate::index::update::PhaseOutcome as Phase;
            report.components.insert(
                component,
                match outcome {
                    Phase::Complete { items } => Outcome::Complete { items },
                    Phase::Unchanged => Outcome::Unchanged,
                    Phase::NotRun => Outcome::NotRun,
                    Phase::Incomplete {
                        completed,
                        expected,
                        reason,
                    } => Outcome::Incomplete {
                        completed,
                        expected,
                        reason,
                    },
                },
            );
        }
        progress.phase("checking knowledge", "knowledge", None)?;
        let mut reads = knowledge::Reads::default();
        match self.knowledge.refresh(request.knowledge, force, &mut reads) {
            Ok((assessed, published)) => {
                report.knowledge_assessed = assessed;
                report.knowledge_published = published;
                report.components.insert(
                    "knowledge",
                    match self.knowledge.assessed_items {
                        None => Outcome::Unconfigured,
                        Some(count) if reads.journal_replays > 0 => {
                            Outcome::Complete { items: Some(count) }
                        }
                        Some(_) => Outcome::Unchanged,
                    },
                );
            }
            Err(error) => {
                report.components.insert(
                    "knowledge",
                    Outcome::Failed {
                        reason: format!("{error:#}"),
                    },
                );
                if let Some(status) = &mut progress.status {
                    status.target(self.knowledge.target.clone());
                    status.record(
                        "processing-knowledge",
                        "knowledge",
                        "failure",
                        Some(&error.to_string()),
                    );
                }
                remove(root, "knowledge.json")?;
                report.errors.push(format!("knowledge: {error:#}"));
            }
        }
        report.knowledge_support_reads = reads.support;
        report.knowledge_journal_replays = reads.journal_replays;
        progress.phase("finalizing", "source", None)?;
        report.state_published = persist(
            root,
            "state.json",
            &json!({"version":1,
            "source":if !complete {"incomplete"} else if report.warnings.unsupported_encoding_files > 0 {"partial"} else {"current"},
            "inputs":inputs, "warnings":report.warnings, "diagnostics":report.diagnostics, "errors":report.errors}),
        )?;
        if let Some(status) = &mut progress.status {
            // Publish the final file event before domain observations replace its
            // in-progress status. A later heartbeat must not downgrade the result.
            status.flush(true);
            status.target(None);
            if complete && (force || report.indexed > 0 || report.invalidated > 0) {
                status.record("processing-source", "source", "success", None);
                for component in ["analysis", "vectors_model"] {
                    status.observe(
                        component,
                        "observed",
                        "source publication observed; use explicit validation for current freshness",
                    );
                }
            }
            if source.graph_validated {
                status.observe(
                    "relationships",
                    "assessed_current",
                    "complete relationship inputs checked at this time; later changes require validation",
                );
            }
            if matches!(
                report.components.get("relationships"),
                Some(Outcome::Incomplete { .. })
            ) || (!source.graph_validated && !report.errors.is_empty())
            {
                status.observe(
                    "relationships",
                    "incomplete",
                    "relationship processing did not complete; saved view requires validation",
                );
            }
            if report.warnings.unsupported_encoding_files > 0 {
                status.observe("source", "partial", "readable source processed; unsupported encodings listed in processing diagnostics");
            }
            if report.knowledge_assessed {
                status.target(self.knowledge.target.clone());
                status.record("processing-knowledge", "knowledge", "success", None);
                status.target(None);
            }
            status.target(self.knowledge.target.clone());
            match report.components.get("knowledge") {
                Some(Outcome::Complete { items: Some(count) }) => status.observe(
                    "knowledge",
                    if *count == 0 {
                        "configured_empty"
                    } else {
                        "assessed"
                    },
                    &format!(
                        "{count} claims mechanically assessed at this time; declared evidence only"
                    ),
                ),
                Some(Outcome::Unconfigured) => status.observe(
                    "knowledge",
                    "unconfigured",
                    "no knowledge identity configured",
                ),
                _ => {}
            }
            status.target(None);
        }
        // Publication can change directory metadata but never belongs to the source selection.
        Ok(report)
    }
}
