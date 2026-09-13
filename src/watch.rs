//! Foreground reconciliation. Semantic knowledge writes remain explicit actor actions.
use crate::index::graph;
#[cfg(test)]
use crate::index::update::indexed_paths;
use crate::knowledge::observation as knowledge;

use crate::files::cache::{load, persist, remove};
use crate::{
    analysis,
    embedding::{self, Embedder},
};
use anyhow::{Result, ensure};
use clap::Args;
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};

#[derive(Args, Default)]
pub struct Options {
    #[arg(long, default_value = ".")]
    pub root: PathBuf,
    /// Reconcile once and exit. No background service is installed.
    #[arg(long, conflicts_with = "status")]
    pub once: bool,
    /// Validate cached views without loading an embedding model.
    #[arg(long)]
    pub status: bool,
    #[arg(long, default_value_t = 1000)]
    pub interval_ms: u64,
    #[arg(long, default_value_t = 250)]
    pub debounce_ms: u64,
    #[arg(long, default_value_t = 30000)]
    pub reconcile_ms: u64,
    #[arg(long)]
    pub repository: Option<String>,
    #[arg(long)]
    pub default_branch: Option<String>,
    #[arg(long)]
    pub state: Option<PathBuf>,
}

#[derive(Default, Debug, Serialize)]
pub struct Cycle {
    selected_source_reads: usize,
    knowledge_support_reads: usize,
    knowledge_journal_replays: usize,
    analyzed: usize,
    embedded_documents: usize,
    indexed: usize,
    invalidated: usize,
    graph_rebuilt: bool,
    graph_published: bool,
    knowledge_assessed: bool,
    knowledge_published: bool,
    state_published: bool,
    errors: Vec<String>,
}
#[derive(Default)]
struct Engine {
    source: crate::index::update::Update,
    knowledge: knowledge::Watcher,
    status: Option<crate::status::Activity>,
}
impl Engine {
    fn cycle(
        &mut self,
        options: &Options,
        force: bool,
        make: impl FnOnce() -> Result<Embedder>,
        extract: impl Fn(crate::source::SourceFile) -> Result<analysis::Analysis>,
    ) -> Result<Cycle> {
        let root = &options.root;
        // Ownership still covers observation, invalidation and both publications.
        let _lock = crate::storage::writer::acquire(root)?;
        let source = self.source.run(
            crate::index::update::Options {
                root,
                force,
                settle: (options.debounce_ms > 0 && !options.once)
                    .then(|| Duration::from_millis(options.debounce_ms)),
            },
            make,
            extract,
            &mut self.status,
        )?;
        let complete = source.complete;
        let inputs = source.inputs;
        let mut report = Cycle {
            selected_source_reads: source.selected_source_reads,
            analyzed: source.analyzed,
            embedded_documents: source.embedded_documents,
            indexed: source.indexed,
            invalidated: source.invalidated,
            graph_rebuilt: source.graph_rebuilt,
            graph_published: source.graph_published,
            errors: source.errors,
            ..Default::default()
        };
        let mut reads = knowledge::Reads::default();
        match self
            .knowledge
            .refresh(&options.knowledge(), force, &mut reads)
        {
            Ok((assessed, published)) => {
                report.knowledge_assessed = assessed;
                report.knowledge_published = published;
            }
            Err(error) => {
                if let Some(status) = &mut self.status {
                    status.target(self.knowledge.target.clone());
                    status.record(
                        "watch-knowledge",
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
        report.state_published = persist(
            root,
            "state.json",
            &json!({"version":1,
            "source":if !complete {"incomplete"} else {"current"},
            "inputs":inputs, "errors":report.errors}),
        )?;
        if let Some(status) = &mut self.status {
            status.target(None);
            if complete && (force || report.indexed > 0 || report.invalidated > 0) {
                status.record("watch-source", "source", "success", None);
                for component in ["analysis", "vectors_model"] {
                    status.observe(
                        component,
                        "observed",
                        "watch publication observed; use explicit validation for current freshness",
                    );
                }
            }
            if report.graph_published {
                status.observe(
                    "relationships",
                    "observed",
                    "watch graph published at this time; validation remains explicit",
                );
            }
            if report.knowledge_assessed {
                status.target(self.knowledge.target.clone());
                status.record("watch-knowledge", "knowledge", "success", None);
                status.target(None);
            }
            status.progress("watching", "source", Some("."));
        }
        // Publication can change directory metadata but never belongs to the source selection.
        Ok(report)
    }
}

impl Options {
    fn knowledge(&self) -> knowledge::Options {
        knowledge::Options {
            root: self.root.clone(),
            repository: self.repository.clone(),
            state: self.state.clone(),
            default_branch: self.default_branch.clone(),
        }
    }
}

pub fn diagnostics(options: &Options) -> Value {
    json!({"last_run":load(&options.root,"state.json").ok().flatten(),"relationships":graph::summary(&options.root),"knowledge":knowledge::read(&options.knowledge())})
}

pub fn run(mut options: Options) -> Result<()> {
    options.root = options.root.canonicalize()?;
    if options.status {
        println!("{}", diagnostics(&options));
        return Ok(());
    }
    ensure!(
        options.interval_ms > 0 && options.reconcile_ms > 0,
        "watch intervals must be positive"
    );
    let mut engine = Engine {
        status: Some(crate::status::Activity::start(
            &options.root,
            "watch",
            "source",
        )),
        ..Default::default()
    };
    if let Some(status) = &mut engine.status {
        status.completion(&[]);
    }
    let mut full = Instant::now();
    let mut startup = true;
    loop {
        let force = startup || full.elapsed() >= Duration::from_millis(options.reconcile_ms);
        if force {
            full = Instant::now();
        }
        startup = false;
        match engine.cycle(&options, force, embedding::production, analysis::extract) {
            Ok(report) => {
                if options.once
                    || report.state_published
                    || report.graph_published
                    || report.knowledge_published
                {
                    println!("{}", serde_json::to_string(&report)?);
                }
                if options.once {
                    if let Some(status) = &mut engine.status {
                        status.finish(
                            if report.errors.is_empty() {
                                "success"
                            } else {
                                "incomplete"
                            },
                            report.errors.first().map(String::as_str),
                            None,
                            None,
                        );
                    }
                    ensure!(report.errors.is_empty(), "watch reconciliation incomplete");
                    return Ok(());
                }
            }
            Err(error) => {
                if options.once {
                    if let Some(status) = &mut engine.status {
                        status.finish("failure", Some(&error.to_string()), None, None);
                    }
                    return Err(error);
                }
                if let Some(status) = &mut engine.status {
                    status.failed("watch-source", &error.to_string());
                }
                eprintln!("watch: {error:#}");
            }
        }
        std::thread::sleep(Duration::from_millis(options.interval_ms));
    }
}

#[cfg(test)]
#[path = "../tests/unit/watch.rs"]
mod tests;
