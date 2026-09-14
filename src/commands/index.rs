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
    let result = (|| -> anyhow::Result<()> {
        let root = Path::new(".").canonicalize()?;
        let elapsed = || start.elapsed();
        let mut output = stderr;
        crate::index::progress::live(&root, &mut output, terminal, &elapsed, |progress| {
            progress.profile = profile.clone();
            progress.status = Some(crate::status::Activity::start(&root, "index", "source"));
            execute(
                &root,
                || embedding::production_profiled(cache_dir, profile.clone()),
                progress,
                &mut io::stdout().lock(),
            )
            .map(|_| ())
        })
    })();
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

/// The production command path also accepts deterministic workers in regression tests.
pub(crate) fn execute(
    root: &Path,
    make: impl FnOnce() -> anyhow::Result<embedding::Embedder>,
    progress: &mut crate::index::progress::Progress<'_>,
    output: &mut dyn Write,
) -> anyhow::Result<crate::processor::ProcessingResult> {
    let result = crate::processor::Session::default().process(
        crate::processor::Request {
            root,
            knowledge: &crate::knowledge::observation::Options {
                root: root.to_path_buf(),
                ..Default::default()
            },
            force: true,
        },
        make,
        crate::analysis::extract,
        progress,
    );
    if let Some(status) = &mut progress.status {
        status.completion(&[]);
        match &result {
            Ok(report) if !report.errors.is_empty() => status.finish(
                "incomplete",
                report.errors.first().map(String::as_str),
                None,
                None,
            ),
            _ => status.result(&result),
        }
    }
    progress.clear()?;
    let report = result?;
    report.write_summary(output)?;
    writeln!(output, "time: {:.2} seconds", progress.elapsed().as_secs_f64())?;
    if !report.errors.is_empty() {
        anyhow::bail!(
            "processing failed: {}",
            crate::files::preview(&report.errors[0], 500)
        );
    }
    Ok(report)
}
