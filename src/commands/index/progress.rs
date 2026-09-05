use std::io::{self, Write};
use std::path::Path;
use std::time::Duration;

pub(super) struct Progress<'a> {
    root: String,
    output: &'a mut dyn Write,
    terminal: bool,
    elapsed: &'a dyn Fn() -> Duration,
    lines: usize,
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
            output,
            terminal,
            elapsed,
            lines: 0,
        }
    }

    pub(super) fn is_terminal(&self) -> bool {
        self.terminal
    }

    pub(super) fn walking(&mut self, file: &str, found: usize) -> io::Result<()> {
        self.render(&format!(
            "indexing: {}\nphase: walking\nfile: {}\nfiles_found: {found}\nelapsed_time: {:.2} seconds\n",
            self.root, plain(file), (self.elapsed)().as_secs_f64(),
        ))
    }

    pub(super) fn indexing(
        &mut self,
        file: &str,
        windows: (usize, usize),
        files: (usize, usize),
        finished: bool,
    ) -> io::Result<()> {
        self.render(&format!(
            "indexing: {}\nphase: indexing\nfile: {}\nfile_progress: {}% ({}/{} windows)\nindex_progress: {}% ({}/{} files)\nelapsed_time: {:.2} seconds\n",
            self.root, plain(file), percent(windows, finished), windows.0, windows.1,
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
        if self.lines > 0 {
            write!(self.output, "\x1b[{}F\x1b[J", self.lines)?;
            self.lines = 0;
            self.output.flush()?;
        }
        Ok(())
    }

    pub(super) fn diagnostic(&mut self, message: &str) -> io::Result<()> {
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
#[path = "../../../tests/unit/commands/index/progress.rs"]
mod tests;
