use std::path::{Path, PathBuf};
use std::sync::mpsc::Sender;

use anyhow::Result;
use globset::GlobSet;
use notify::event::{AccessKind, AccessMode};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};

use crate::config::Config;
use crate::discover::{excluded_dir_set, glob_set};

/// What the writer hears from the file watcher.
#[derive(Debug, PartialEq)]
pub enum Change {
    /// A project path that may be indexed changed.
    Files,
    /// The watcher lost events, so any file may have changed.
    Lost,
    /// `.mimirs/config.toml` changed; applying it needs a restart.
    Config,
}

/// Watch `root` recursively and send each relevant change. Watching stops when
/// the returned watcher is dropped.
pub fn watch(root: &Path, config: &Config, changes: Sender<Change>) -> Result<RecommendedWatcher> {
    // FSEvents reports resolved paths, such as `/private/var` for `/var`.
    let root = root.canonicalize()?;
    let filter = Filter {
        root: root.clone(),
        exclude: glob_set(&config.exclude)?,
        excluded_dirs: excluded_dir_set(&config.exclude)?,
    };
    let mut limit_reported = false;
    let mut watcher = notify::recommended_watcher(move |result: notify::Result<Event>| {
        match result {
            Ok(event) => {
                if let Some(change) = filter.classify(&event) {
                    // The writer only stops when the process ends.
                    let _ = changes.send(change);
                }
            }
            Err(error) if is_watch_limit(&error) => {
                if !limit_reported {
                    report_watch_limit();
                    limit_reported = true;
                }
            }
            Err(error) => eprintln!("mimirs: file watcher error: {error}"),
        }
    })?;

    match watcher.watch(&root, RecursiveMode::Recursive) {
        Ok(()) => {}
        // Directories past the limit stay unwatched; the timed catch-up covers them.
        Err(error) if is_watch_limit(&error) => report_watch_limit(),
        Err(error) => return Err(error.into()),
    }
    Ok(watcher)
}

fn is_watch_limit(error: &notify::Error) -> bool {
    matches!(error.kind, notify::ErrorKind::MaxFilesWatch)
}

fn report_watch_limit() {
    eprintln!(
        "mimirs: reached the system limit on watched folders, so some changes are only \
         seen by the catch-up every minute. Raise fs.inotify.max_user_watches, or exclude \
         large folders in .mimirs/config.toml."
    );
}

struct Filter {
    root: PathBuf,
    exclude: GlobSet,
    excluded_dirs: GlobSet,
}

impl Filter {
    fn classify(&self, event: &Event) -> Option<Change> {
        // Lost-event signals often carry no path.
        if event.need_rescan() {
            return Some(Change::Lost);
        }
        // Our own walks and reads open files; only a finished write is a change.
        if let EventKind::Access(kind) = event.kind
            && kind != AccessKind::Close(AccessMode::Write)
        {
            return None;
        }
        let mut change = None;
        for path in &event.paths {
            match self.path_change(path) {
                Some(Change::Files) => return Some(Change::Files),
                Some(other) => change = Some(other),
                None => {}
            }
        }
        change
    }

    fn path_change(&self, path: &Path) -> Option<Change> {
        let relative_path = path.strip_prefix(&self.root).ok()?;
        if relative_path == Path::new(".mimirs/config.toml") {
            return Some(Change::Config);
        }
        // The index database lives here; its writes must not trigger catch-ups,
        // whatever the config excludes.
        if relative_path.starts_with(".mimirs") {
            return None;
        }
        if self.exclude.is_match(relative_path) || self.excluded_dirs.is_match(relative_path) {
            return None;
        }
        Some(Change::Files)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{CreateKind, Flag, ModifyKind};

    fn filter() -> Result<Filter> {
        let exclude = vec![".git/**".to_string(), "**/node_modules/**".to_string()];
        Ok(Filter {
            root: PathBuf::from("/project"),
            exclude: glob_set(&exclude)?,
            excluded_dirs: excluded_dir_set(&exclude)?,
        })
    }

    fn event(kind: EventKind, path: &str) -> Event {
        Event::new(kind).add_path(PathBuf::from(path))
    }

    #[test]
    fn keeps_project_changes() -> Result<()> {
        let filter = filter()?;
        let edit = EventKind::Modify(ModifyKind::Any);
        assert_eq!(
            filter.classify(&event(edit, "/project/src/main.rs")),
            Some(Change::Files)
        );
        let created = EventKind::Create(CreateKind::Folder);
        assert_eq!(
            filter.classify(&event(created, "/project/lib")),
            Some(Change::Files)
        );
        let written = EventKind::Access(AccessKind::Close(AccessMode::Write));
        assert_eq!(
            filter.classify(&event(written, "/project/src/main.rs")),
            Some(Change::Files)
        );
        Ok(())
    }

    #[test]
    fn drops_reads_excludes_and_the_index() -> Result<()> {
        let filter = filter()?;
        let opened = EventKind::Access(AccessKind::Open(AccessMode::Any));
        assert_eq!(
            filter.classify(&event(opened, "/project/src/main.rs")),
            None
        );
        let edit = EventKind::Modify(ModifyKind::Any);
        for path in [
            "/project/.git",
            "/project/.git/index",
            "/project/web/node_modules/lib/index.js",
            "/project/.mimirs/index.db-wal",
            "/elsewhere/main.rs",
        ] {
            assert_eq!(filter.classify(&event(edit, path)), None, "{path}");
        }
        Ok(())
    }

    #[test]
    fn reports_config_edits_and_lost_events() -> Result<()> {
        let filter = filter()?;
        let edit = EventKind::Modify(ModifyKind::Any);
        assert_eq!(
            filter.classify(&event(edit, "/project/.mimirs/config.toml")),
            Some(Change::Config)
        );
        let lost = Event::new(EventKind::Other).set_flag(Flag::Rescan);
        assert_eq!(filter.classify(&lost), Some(Change::Lost));
        Ok(())
    }
}
