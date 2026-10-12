use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::indexing::Summary;

/// Least time between two progress writes. One write costs about 130 µs, and
/// a no-change walk finishes thousands of files in a few hundred ms.
const PROGRESS_INTERVAL: Duration = Duration::from_secs(1);

/// The writer's record in `.mimirs/status`, kept for debugging after the
/// fact. The first line is the state; `key: value` lines follow.
///
/// Only the writer-lock holder writes, and after `stopped` or `error` the
/// file no longer changes, so a late write cannot hide why the writer ended.
pub struct Status {
    state: Mutex<State>,
}

struct State {
    path: PathBuf,
    holds_lock: bool,
    ended: bool,
    started: String,
    last_progress: Option<Instant>,
}

/// Why the index writer stopped, as `.mimirs/status` recorded it.
pub struct Failure {
    pub failed: String,
    pub message: String,
}

/// The writer's failure, when the status says `error`. Every other state, and
/// a file that is missing or cannot be read, gives `None`: the file is for
/// debugging and must not block a query.
pub fn read_failure(root: &Path) -> Option<Failure> {
    let text = fs::read_to_string(root.join(".mimirs/status")).ok()?;
    parse_failure(&text)
}

fn parse_failure(text: &str) -> Option<Failure> {
    let mut lines = text.lines();
    if lines.next()? != "error" {
        return None;
    }
    let mut failed = None;
    let mut message = None;
    for line in lines {
        if let Some(value) = line.strip_prefix("failed: ") {
            failed = Some(value.to_string());
        } else if let Some(value) = line.strip_prefix("message: ") {
            message = Some(value.to_string());
        }
    }
    Some(Failure {
        failed: failed?,
        message: message?,
    })
}

/// The last catch-up or update that changed the index.
pub struct IndexChange {
    at: String,
    indexed: usize,
    unchanged: usize,
    removed: usize,
}

impl IndexChange {
    pub fn now(summary: &Summary) -> Self {
        Self {
            at: now(),
            indexed: summary.files,
            unchanged: summary.unchanged,
            removed: summary.removed,
        }
    }
}

impl Status {
    pub fn new(root: &Path) -> Self {
        Self {
            state: Mutex::new(State {
                path: root.join(".mimirs/status"),
                holds_lock: false,
                ended: false,
                started: String::new(),
                last_progress: None,
            }),
        }
    }

    /// Allow writes from now on. A process waiting for the lock must not
    /// replace the holder's record.
    pub fn hold_lock(&self) {
        self.lock().holds_lock = true;
    }

    pub fn catching_up(&self) {
        let mut state = self.lock();
        state.started = now();
        state.last_progress = None;
        let text = format!("catching up\nstarted: {}\n", state.started);
        state.write(&text);
    }

    /// Record `done` of `total` files, at most once per `PROGRESS_INTERVAL`
    /// and always the first time after `catching_up`.
    pub fn progress(&self, done: usize, total: usize) {
        let mut state = self.lock();
        let due = state
            .last_progress
            .is_none_or(|at| at.elapsed() >= PROGRESS_INTERVAL);
        if !due {
            return;
        }
        state.last_progress = Some(Instant::now());
        let text = format!(
            "catching up\nstarted: {}\nprogress: {done}/{total} files\n",
            state.started
        );
        state.write(&text);
    }

    pub fn watching(&self, last_change: &IndexChange) {
        let text = format!(
            "watching\nchecked: {}\nchanged: {}\n{}\n",
            now(),
            last_change.at,
            counts(
                last_change.indexed,
                last_change.unchanged,
                last_change.removed
            )
        );
        self.lock().write(&text);
    }

    pub fn indexed(&self, summary: &Summary) {
        let text = format!(
            "indexed\nfinished: {}\n{}\n",
            now(),
            counts(summary.files, summary.unchanged, summary.removed)
        );
        self.lock().write(&text);
    }

    /// Record why the writer failed. `message` may span lines; the file keeps
    /// it on one.
    pub fn error(&self, message: &str) {
        let message = message.replace('\n', " ");
        let text = format!("error\nfailed: {}\nmessage: {message}\n", now());
        let mut state = self.lock();
        state.write(&text);
        state.ended = true;
    }

    pub fn stopped(&self) {
        let text = format!("stopped\nstopped: {}\n", now());
        let mut state = self.lock();
        state.write(&text);
        state.ended = true;
    }

    /// A panic while holding the lock must not stop the last write.
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl State {
    /// Replace the file through a rename, so a reader never sees half of it. A
    /// failed write must not stop the writer, so it only prints a line.
    fn write(&self, text: &str) {
        if !self.holds_lock || self.ended {
            return;
        }
        let temporary = self.path.with_extension("tmp");
        let written = fs::write(&temporary, text).and_then(|()| fs::rename(&temporary, &self.path));
        if let Err(error) = written {
            eprintln!("mimirs: could not write {}: {error}", self.path.display());
        }
    }
}

fn counts(indexed: usize, unchanged: usize, removed: usize) -> String {
    format!("indexed: {indexed}, unchanged: {unchanged}, removed: {removed}")
}

fn now() -> String {
    // A clock before 1970 is not worth an error in a debugging file.
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_secs());
    iso_time(seconds)
}

/// Unix seconds as ISO 8601 in UTC, such as `2026-10-11T14:05:31Z`.
fn iso_time(unix_seconds: u64) -> String {
    let (year, month, day) = civil_date(unix_seconds / 86_400);
    let seconds_of_day = unix_seconds % 86_400;
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        seconds_of_day / 3_600,
        seconds_of_day % 3_600 / 60,
        seconds_of_day % 60
    )
}

/// The year, month, and day `days` after 1970-01-01, by Howard Hinnant's
/// `civil_from_days`. It counts years from March, so a leap day falls at the
/// end of a year, and works in 400-year eras of 146,097 days.
fn civil_date(days: u64) -> (u64, u64, u64) {
    // Days from 0000-03-01 to 1970-01-01.
    let days = days + 719_468;
    let era = days / 146_097;
    let day_of_era = days % 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_from_march = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_from_march + 2) / 5 + 1;
    let month = if month_from_march < 10 {
        month_from_march + 3
    } else {
        month_from_march - 9
    };
    let year = era * 400 + year_of_era + u64::from(month <= 2);
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::Result;

    #[test]
    fn iso_times_match_known_dates() {
        assert_eq!(iso_time(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso_time(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(iso_time(1_704_067_199), "2023-12-31T23:59:59Z");
        assert_eq!(iso_time(1_704_067_200), "2024-01-01T00:00:00Z");
        assert_eq!(iso_time(1_791_727_531), "2026-10-11T14:05:31Z");
    }

    fn project() -> Result<tempfile::TempDir> {
        let project = tempfile::tempdir()?;
        fs::create_dir(project.path().join(".mimirs"))?;
        Ok(project)
    }

    fn state_of(project: &tempfile::TempDir) -> Result<String> {
        let text = fs::read_to_string(project.path().join(".mimirs/status"))?;
        Ok(text.lines().next().unwrap_or_default().to_string())
    }

    #[test]
    fn only_a_complete_error_is_a_failure() -> Result<()> {
        let project = project()?;
        assert!(read_failure(project.path()).is_none());

        let failure = parse_failure("error\nfailed: 2026-10-11T14:05:31Z\nmessage: disk gone\n")
            .expect("a complete error");
        assert_eq!(failure.failed, "2026-10-11T14:05:31Z");
        assert_eq!(failure.message, "disk gone");

        assert!(parse_failure("error\nfailed: 2026-10-11T14:05:31Z\n").is_none());
        assert!(parse_failure("watching\nchecked: 2026-10-11T14:05:31Z\n").is_none());
        assert!(parse_failure("").is_none());
        Ok(())
    }

    #[test]
    fn a_process_without_the_lock_writes_nothing() -> Result<()> {
        let project = project()?;
        let status = Status::new(project.path());
        status.catching_up();
        status.stopped();
        assert!(!project.path().join(".mimirs/status").exists());
        Ok(())
    }

    #[test]
    fn an_error_outlasts_later_writes() -> Result<()> {
        let project = project()?;
        let status = Status::new(project.path());
        status.hold_lock();
        status.error("the file watcher\nstopped");
        status.stopped();
        status.catching_up();
        status.progress(1, 2);
        let text = fs::read_to_string(project.path().join(".mimirs/status"))?;
        assert!(text.starts_with("error\nfailed: "));
        assert!(text.ends_with("message: the file watcher stopped\n"));
        Ok(())
    }

    #[test]
    fn stopped_outlasts_later_writes() -> Result<()> {
        let project = project()?;
        let status = Status::new(project.path());
        status.hold_lock();
        status.stopped();
        status.progress(1, 2);
        status.watching(&IndexChange::now(&Summary::default()));
        assert_eq!(state_of(&project)?, "stopped");
        Ok(())
    }

    #[test]
    fn each_catch_up_writes_its_first_progress_line() -> Result<()> {
        let project = project()?;
        let status = Status::new(project.path());
        status.hold_lock();
        let progress_line = || -> Result<String> {
            let text = fs::read_to_string(project.path().join(".mimirs/status"))?;
            Ok(text.lines().last().unwrap_or_default().to_string())
        };

        status.catching_up();
        status.progress(0, 10);
        assert_eq!(progress_line()?, "progress: 0/10 files");
        status.progress(5, 10);
        assert_eq!(progress_line()?, "progress: 0/10 files");

        status.catching_up();
        status.progress(1, 3);
        assert_eq!(progress_line()?, "progress: 1/3 files");
        Ok(())
    }
}
