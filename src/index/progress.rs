use std::io::{self, Write};
use std::path::Path;
use std::time::Duration;

pub(super) struct Progress<'a> {
    root: String,
    status: Option<crate::status::Activity>,
    last_issue: Option<(Option<String>, String)>,
    output: &'a mut dyn Write,
    terminal: bool,
    elapsed: &'a dyn Fn() -> Duration,
    lines: usize,
    profile: crate::profiling::Profiler,
}

impl<'a> Progress<'a> {
    pub(super) fn new(
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
            profile: crate::profiling::Profiler::default(),
        }
    }

    pub(super) fn with_status(mut self, mut status: crate::status::Activity) -> Self {
        completion(&mut status, false);
        self.status = Some(status);
        self
    }
    pub(super) fn phase(&mut self, phase: &str, component: &str, file: Option<&str>) {
        if let Some(status) = &mut self.status {
            status.progress(phase, component, file);
        }
    }
    pub(super) fn published(&mut self, path: &str) {
        if let Some(status) = &mut self.status {
            status.published(path);
        }
    }
    pub(super) fn issue(&mut self, file: Option<&str>, reason: &str) {
        self.last_issue = Some((file.map(str::to_owned), reason.to_owned()));
    }
    pub(super) fn finish_status(&mut self, result: &anyhow::Result<super::Summary>) {
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
    pub(super) fn with_profile(mut self, profile: crate::profiling::Profiler) -> Self {
        self.profile = profile;
        self
    }

    pub(super) fn set_profile(&mut self, profile: crate::profiling::Profiler) {
        self.profile = profile;
    }

    pub(super) fn is_terminal(&self) -> bool {
        self.terminal
    }

    pub(super) fn walking(&mut self, file: &str, found: usize) -> io::Result<()> {
        self.phase("walking", "source", Some(file));
        let _scope = self.profile.scope("progress_output");
        self.render(&format!(
            "indexing: {}\nphase: walking\nfile: {}\nfiles_found: {found}\nelapsed_time: {:.2} seconds\n",
            self.root, plain(file), (self.elapsed)().as_secs_f64(),
        ))
    }

    pub(super) fn indexing(
        &mut self,
        file: &str,
        documents: (usize, usize),
        files: (usize, usize),
        finished: bool,
    ) -> io::Result<()> {
        let _scope = self.profile.scope("progress_output");
        self.phase("indexing", "vectors_model", Some(file));
        if files.1 == usize::MAX {
            return self.render(&format!(
                "indexing: {}\nphase: indexing\nfile: {}\nfile_progress: {}% ({}/{} documents)\nfiles_completed: {} (discovery in progress)\nelapsed_time: {:.2} seconds\n",
                self.root, plain(file), percent(documents, finished), documents.0, documents.1,
                files.0, (self.elapsed)().as_secs_f64()));
        }
        self.render(&format!(
            "indexing: {}\nphase: indexing\nfile: {}\nfile_progress: {}% ({}/{} documents)\nindex_progress: {}% ({}/{} files)\nelapsed_time: {:.2} seconds\n",
            self.root, plain(file), percent(documents, finished), documents.0, documents.1,
            percent(files, finished), files.0, files.1, (self.elapsed)().as_secs_f64(),
        ))
    }

    fn render(&mut self, block: &str) -> io::Result<()> {
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

    pub(super) fn clear(&mut self) -> io::Result<()> {
        let _scope = self.profile.scope("progress_output");
        if self.lines > 0 {
            write!(self.output, "\x1b[{}F\x1b[J", self.lines)?;
            self.lines = 0;
            self.output.flush()?;
        }
        Ok(())
    }

    pub(super) fn diagnostic(&mut self, message: &str) -> io::Result<()> {
        let _scope = self.profile.scope("progress_output");
        self.clear()?;
        writeln!(self.output, "{}", plain(message))?;
        self.output.flush()
    }
}

fn percent((done, total): (usize, usize), finished: bool) -> usize {
    if total == 0 {
        return if finished { 100 } else { 0 };
    }
    (100.0 * done as f64 / total as f64).round() as usize
}

// Paths and error messages can contain control characters. Keep every output
// field on one line and reserve terminal controls for the renderer.
fn plain(value: &str) -> String {
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

fn completion(status: &mut crate::status::Activity, successful: bool) {
    let state = if successful { "observed" } else { "incomplete" };
    let basis = "last index publication result; current source freshness is unknown";
    status.completion(&[
        ("source", state, basis),
        ("analysis", state, basis),
        ("vectors_model", state, basis),
        (
            "relationships",
            "stale",
            "index operation does not publish the watch relationship view",
        ),
    ]);
}
