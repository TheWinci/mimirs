use crate::{embedding, profiling::Profiler};
use anyhow::{Context, ensure};
use std::{
    io::{self, IsTerminal, Write},
    path::{Path, PathBuf},
    time::Instant,
};
pub fn run(report_path: Option<&Path>, cache_dir: Option<PathBuf>) -> anyhow::Result<()> {
    if let Some(path) = report_path {
        ensure!(
            !path.try_exists()?,
            "profile report already exists: {}",
            path.display()
        );
    }
    let profile = report_path.map_or_else(Profiler::default, |_| {
        Profiler::enabled(crate::embedding::model_identity())
    });
    let start = Instant::now();
    let stderr = io::stderr();
    let terminal = stderr.is_terminal();
    let result = crate::index::run_at_profiled(
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
