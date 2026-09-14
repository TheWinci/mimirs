mod live;
pub(crate) use live::run as live;

trait Screen {
    fn render(&self, frame: &str) -> io::Result<()>;
    fn clear(&self) -> io::Result<()>;
    fn diagnostic(&self, message: &str) -> io::Result<()>;
}

use std::io::{self, Write};
use std::path::Path;
use std::time::Duration;

#[derive(Clone, Copy)]
pub(crate) enum Work {
    Unknown,
    NotApplicable,
    Known { done: usize, total: usize },
}
impl Work {
    fn label(self, unit: &str) -> String {
        match self {
            Self::Unknown => format!("unknown ({unit})"),
            Self::NotApplicable => "not applicable".into(),
            Self::Known { done, total: 0 } => format!("{done}/0 {unit} (no work)"),
            Self::Known { done, total } => {
                format!("{}% ({done}/{total} {unit})", percent((done, total)))
            }
        }
    }
}
#[derive(Clone, Copy, PartialEq)]
pub(crate) enum FileOutcome {
    Processing,
    Published,
    Reused,
    Skipped,
    Empty,
    Recovered,
}
impl FileOutcome {
    fn label(self) -> &'static str {
        match self {
            Self::Processing => "processing",
            Self::Published => "published",
            Self::Reused => "reused",
            Self::Skipped => "skipped",
            Self::Empty => "empty",
            Self::Recovered => "recovered",
        }
    }
}

pub(crate) struct Progress<'a> {
    root: String,
    pub(crate) status: Option<crate::status::Activity>,
    last_issue: Option<(Option<String>, String)>,
    output: &'a mut dyn Write,
    terminal: bool,
    elapsed: &'a dyn Fn() -> Duration,
    lines: usize,
    concise: bool,
    screen: Option<&'a dyn Screen>,
    files: Option<(usize, usize)>,
    pub(crate) profile: crate::profiling::Profiler,
}

impl<'a> Progress<'a> {
    pub(crate) fn new(
        root: &Path,
        output: &'a mut dyn Write,
        terminal: bool,
        elapsed: &'a dyn Fn() -> Duration,
    ) -> Self {
        Self {
            root: plain(&root.display().to_string()),
            status: None,
            last_issue: None,
            output,
            terminal,
            elapsed,
            lines: 0,
            concise: false,
            screen: None,
            files: None,
            profile: crate::profiling::Profiler::default(),
        }
    }

    pub(crate) fn elapsed(&self) -> Duration {
        (self.elapsed)()
    }

    pub(crate) fn concise(&mut self) {
        self.concise = true;
    }
    pub(crate) fn syntax(
        &mut self,
        path: &str,
        diagnostic: &crate::analysis::Diagnostic,
    ) -> io::Result<()> {
        if self.concise {
            return Ok(());
        }
        self.diagnostic(&format!(
            "syntax: {path}:{}:{} {}",
            diagnostic.span.line_start, diagnostic.column, diagnostic.kind
        ))
    }

    #[cfg(test)]
    pub(crate) fn with_status(mut self, mut status: crate::status::Activity) -> Self {
        completion(&mut status, false);
        self.status = Some(status);
        self
    }
    fn status_phase(&mut self, phase: &str, component: &str, file: Option<&str>) {
        if let Some(status) = &mut self.status {
            status.progress(phase, component, file);
        }
    }
    pub(crate) fn phase(
        &mut self,
        phase: &str,
        component: &str,
        file: Option<&str>,
    ) -> io::Result<()> {
        self.status_phase(phase, component, file);
        if !self.terminal {
            return Ok(());
        }
        let counts = self.files.map_or_else(String::new, |(done, total)| {
            format!(
                "files_completed: {}\n",
                if total == usize::MAX {
                    format!("{done} (discovery in progress)")
                } else {
                    Work::Known { done, total }.label("files")
                }
            )
        });
        self.render(&format!(
            "indexing: {}\nphase: {}\nfile: {}\n{}elapsed_time: {:.2} seconds\n",
            self.root,
            plain(phase),
            plain(file.unwrap_or("-")),
            counts,
            (self.elapsed)().as_secs_f64()
        ))
    }
    pub(crate) fn published(&mut self, path: &str) {
        if let Some(status) = &mut self.status {
            status.published(path);
        }
    }
    pub(crate) fn issue(&mut self, file: Option<&str>, reason: &str) {
        self.last_issue = Some((file.map(str::to_owned), reason.to_owned()));
    }
    #[cfg(test)]
    pub(crate) fn finish_status(&mut self, result: &anyhow::Result<super::Summary>) {
        if let Some(status) = &mut self.status {
            completion(
                status,
                result
                    .as_ref()
                    .is_ok_and(|s| s.skipped == 0 && s.walk_errors == 0),
            );
            match result {
                Ok(summary) if summary.skipped > 0 || summary.walk_errors > 0 => {
                    let (file, reason) = self.last_issue.as_ref().map(|(file, reason)| (file.as_deref(), reason.as_str()))
                        .unwrap_or((None, "some files were skipped or discovery was incomplete; other files may have completed"));
                    status.progress("incomplete", "source", file);
                    status.finish("incomplete", Some(reason), None, None);
                }
                _ => status.result(result),
            }
        }
    }
    #[cfg(test)]
    pub(crate) fn with_profile(mut self, profile: crate::profiling::Profiler) -> Self {
        self.profile = profile;
        self
    }

    pub(crate) fn set_profile(&mut self, profile: crate::profiling::Profiler) {
        self.profile = profile;
    }

    pub(crate) fn is_terminal(&self) -> bool {
        self.terminal
    }

    pub(crate) fn observation(&mut self, phase: &str, file: &str, found: usize) -> io::Result<()> {
        self.status_phase(phase, "source", Some(file));
        if !self.terminal {
            return Ok(());
        }
        self.render(&format!("indexing: {}\nphase: {}\nfile: {}\nfiles_observed: {found}\nelapsed_time: {:.2} seconds\n", self.root, plain(phase), plain(file), (self.elapsed)().as_secs_f64()))
    }

    pub(crate) fn walking(&mut self, file: &str, found: usize) -> io::Result<()> {
        self.status_phase("walking", "source", Some(file));
        if self.concise && !self.terminal {
            return self.diagnostic(&format!("indexing: {found} selected files"));
        }
        let _scope = self.profile.scope("progress_output");
        self.render(&format!(
            "indexing: {}\nphase: walking\nfile: {}\nfiles_found: {found}\nelapsed_time: {:.2} seconds\n",
            self.root, plain(file), (self.elapsed)().as_secs_f64(),
        ))
    }

    pub(crate) fn indexing(
        &mut self,
        file: &str,
        documents: (usize, usize),
        files: (usize, usize),
        finished: bool,
    ) -> io::Result<()> {
        let documents = if documents == (0, 0) && !finished {
            Work::Unknown
        } else {
            Work::Known {
                done: documents.0,
                total: documents.1,
            }
        };
        self.file(
            file,
            documents,
            files,
            if finished {
                FileOutcome::Published
            } else {
                FileOutcome::Processing
            },
        )
    }

    pub(crate) fn file(
        &mut self,
        file: &str,
        documents: Work,
        files: (usize, usize),
        outcome: FileOutcome,
    ) -> io::Result<()> {
        self.status_phase(outcome.label(), "vectors_model", Some(file));
        self.files = Some(files);
        if !self.terminal && outcome == FileOutcome::Processing {
            return Ok(());
        }
        let _scope = self.profile.scope("progress_output");
        let count = if files.1 == usize::MAX {
            format!("{} (discovery in progress)", files.0)
        } else {
            Work::Known {
                done: files.0,
                total: files.1,
            }
            .label("files")
        };
        self.render(&format!("indexing: {}\nphase: {}\nfile: {}\nfile_progress: {}\nfiles_completed: {}\nelapsed_time: {:.2} seconds\n",
            self.root, outcome.label(), plain(file), documents.label("documents"), count, (self.elapsed)().as_secs_f64()))
    }

    pub(crate) fn source_complete(&mut self, files: usize) -> io::Result<()> {
        self.status_phase("source complete", "source", None);
        self.files = Some((files, files));
        self.render(&format!(
            "source_processing: complete\nfiles_completed: {files}\n"
        ))
    }

    fn render(&mut self, block: &str) -> io::Result<()> {
        self.status_warning()?;
        if self.concise && !self.terminal {
            return Ok(());
        }
        if let Some(screen) = self.screen {
            return screen.render(block);
        }
        self.clear()?;
        if self.terminal {
            // Disable wrapping so long paths cannot change the block's height.
            self.output.write_all(b"\x1b[?7l")?;
        }
        let written = self.output.write_all(block.as_bytes());
        if self.terminal {
            self.lines = block.lines().count();
            let restored = self.output.write_all(b"\x1b[?7h");
            written?;
            restored?;
        } else {
            written?;
        }
        self.output.flush()
    }

    fn status_warning(&mut self) -> io::Result<()> {
        if let Some(warning) = self
            .status
            .as_ref()
            .and_then(|status| status.take_warning())
        {
            let message = format!(
                "status diagnostic: {}; operation outcome is unchanged. See .mimirs/status.json or mimirs status",
                plain(&warning)
            );
            if let Some(screen) = self.screen {
                return screen.diagnostic(&message);
            }
            self.clear_area()?;
            writeln!(self.output, "{message}")?;
            self.output.flush()?;
        }
        Ok(())
    }
    pub(crate) fn clear(&mut self) -> io::Result<()> {
        self.status_warning()?;
        self.clear_area()
    }
    fn clear_area(&mut self) -> io::Result<()> {
        if let Some(screen) = self.screen {
            return screen.clear();
        }
        let _scope = self.profile.scope("progress_output");
        if self.lines > 0 {
            write!(self.output, "\x1b[{}F\x1b[J", self.lines)?;
            self.lines = 0;
            self.output.flush()?;
        }
        Ok(())
    }

    pub(crate) fn diagnostic(&mut self, message: &str) -> io::Result<()> {
        self.status_warning()?;
        if let Some(screen) = self.screen {
            return screen.diagnostic(&plain(message));
        }
        let _scope = self.profile.scope("progress_output");
        self.clear()?;
        writeln!(self.output, "{}", plain(message))?;
        self.output.flush()
    }
}

fn percent((done, total): (usize, usize)) -> usize {
    if total == 0 {
        return 0;
    }
    let value = (100.0 * done.min(total) as f64 / total as f64).round() as usize;
    if done < total { value.min(99) } else { value }
}

// Paths and error messages can contain control characters. Keep every output
// field on one line and reserve terminal controls for the renderer.
pub(crate) fn plain(value: &str) -> String {
    let mut text = String::with_capacity(value.len());
    for ch in value.chars() {
        if ch.is_control() {
            text.extend(ch.escape_default());
        } else {
            text.push(ch);
        }
    }
    text
}

#[cfg(test)]
#[path = "../../tests/unit/commands/index/progress.rs"]
mod tests;

#[cfg(test)]
fn completion(status: &mut crate::status::Activity, successful: bool) {
    let state = if successful { "observed" } else { "incomplete" };
    let basis = "last index publication result; current source freshness is unknown";
    status.completion(&[
        ("source", state, basis),
        ("analysis", state, basis),
        ("vectors_model", state, basis),
    ]);
}
