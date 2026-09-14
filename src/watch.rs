//! Foreground reconciliation. Semantic knowledge writes remain explicit actor actions.
use crate::index::graph;
#[cfg(test)]
use crate::index::update::indexed_paths;
use crate::knowledge::observation as knowledge;

use crate::files::cache::load;
use crate::{
    analysis,
    embedding::{self, Embedder},
};
use anyhow::{Result, ensure};
use clap::Args;
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

use crate::processor::ProcessingResult as Cycle;
#[derive(Default)]
struct Engine {
    session: crate::processor::Session,
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
        let stderr = std::io::stderr();
        let terminal = std::io::IsTerminal::is_terminal(&stderr);
        let mut output = stderr;
        let start = Instant::now();
        let elapsed = || start.elapsed();
        let cycle = crate::index::progress::live(
            &options.root,
            &mut output,
            terminal,
            &elapsed,
            |progress| {
                progress.status = self.status.take();
                let result = self.session.process(
                    crate::processor::Request {
                        root: &options.root,
                        knowledge: &options.knowledge(),
                        force,
                    },
                    make,
                    extract,
                    progress,
                );
                let cleared = progress.clear();
                self.status = progress.status.take();
                cleared?;
                result
            },
        );
        if let Some(status) = &mut self.status {
            status.resume_warnings();
        }
        cycle
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
        if !options.once && options.debounce_ms > 0 {
            std::thread::sleep(Duration::from_millis(options.debounce_ms));
        }
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
        if let Some(status) = &mut engine.status {
            status.progress("watching", "source", None);
        }
        std::thread::sleep(Duration::from_millis(options.interval_ms));
    }
}

#[cfg(test)]
#[path = "../tests/unit/watch.rs"]
mod tests;
