use std::path::{Path, PathBuf};
use std::thread::JoinHandle;

use anyhow::{Context, Result};
use ignore::WalkBuilder;

use super::selection;
use crate::commands::index::channel::{self, Cancel, Receiver};
use crate::config::Config;
use crate::profiling::Profiler;

#[derive(Debug)]
pub(in crate::commands::index) enum Event {
    Path { path: String, ordinal: usize },
    Error(String),
    End { found: usize },
}

pub(in crate::commands::index) struct Stream {
    receive: Receiver<Event>,
    worker: Option<JoinHandle<()>>,
    cancel: Cancel,
    ended: bool,
}

impl Stream {
    pub fn start(
        root: &Path,
        config: &Config,
        profile: &Profiler,
        cancel: &Cancel,
    ) -> Result<Self> {
        let overrides = selection(root, config)?;
        let (send, receive) = channel::bounded(64, "paths", profile, cancel);
        let root = PathBuf::from(root);
        let profile = profile.clone();
        let cancellation = cancel.clone();
        let worker = std::thread::Builder::new()
            .name("mimirs-walk".into())
            .spawn(move || {
                let _work = profile.scope("discovery");
                let entries = WalkBuilder::new(&root)
                    .overrides(overrides)
                    .hidden(false)
                    .sort_by_file_path(|a, b| sort_key(a).cmp(&sort_key(b)))
                    .build();
                let emit = |event, bytes| {
                    profile.measure("discovery_queue_wait", || send.send(event, bytes).is_ok())
                };
                let mut found = 0;
                for entry in entries {
                    if cancellation.is_cancelled() {
                        return;
                    }
                    let entry = match entry {
                        Ok(entry) => entry,
                        Err(error) => {
                            if !emit(Event::Error(error.to_string()), 0) {
                                return;
                            }
                            continue;
                        }
                    };
                    if let Some(error) = entry.error()
                        && !emit(Event::Error(error.to_string()), 0)
                    {
                        return;
                    }
                    if !entry.file_type().is_some_and(|kind| kind.is_file()) {
                        continue;
                    }
                    let path = entry
                        .path()
                        .strip_prefix(&root)
                        .unwrap_or(entry.path())
                        .to_string_lossy()
                        .into_owned();
                    let bytes = path.len();
                    if !emit(
                        Event::Path {
                            path,
                            ordinal: found,
                        },
                        bytes,
                    ) {
                        return;
                    }
                    found += 1;
                    profile.count("files_discovered", 1);
                    profile.stage_items("discovery", 1);
                }
                emit(Event::End { found }, 0);
            })
            .context("cannot start file discovery")?;
        Ok(Self {
            receive,
            worker: Some(worker),
            cancel: cancel.clone(),
            ended: false,
        })
    }
}

// A directory's first possible descendant starts with `directory/`. Sorting by
// the bare directory name puts foo/x before foo.rs, unlike canonical path order.
fn sort_key(path: &Path) -> String {
    let mut key = path.to_string_lossy().into_owned();
    if path.is_dir() {
        key.push('/');
    }
    key
}

impl Iterator for Stream {
    type Item = Result<Event>;
    fn next(&mut self) -> Option<Self::Item> {
        if self.ended {
            return None;
        }
        match self.receive.recv() {
            Some(event @ Event::End { .. }) => {
                self.ended = true;
                Some(Ok(event))
            }
            Some(event) => Some(Ok(event)),
            None => {
                self.ended = true;
                Some(Err(anyhow::anyhow!(
                    "file discovery interrupted before completion"
                )))
            }
        }
    }
}

impl Drop for Stream {
    fn drop(&mut self) {
        if !self.ended {
            self.cancel.cancel();
        }
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

#[cfg(test)]
#[path = "../../../../tests/unit/commands/index/stream.rs"]
mod tests;
