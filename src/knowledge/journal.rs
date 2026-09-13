use super::{model::*, projection};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Segment {
    version: u32,
    events: Vec<Event>,
}

pub struct Journal {
    directory: PathBuf,
    repository: RepositoryId,
}
impl Journal {
    pub fn new(directory: PathBuf, repository: &RepositoryId) -> Self {
        Self {
            directory,
            repository: repository.clone(),
        }
    }
    pub fn read(&self) -> Result<BTreeMap<EventId, Event>> {
        if !self.directory.try_exists()? {
            return Ok(BTreeMap::new());
        }
        let mut events = Vec::new();
        for entry in fs::read_dir(&self.directory)? {
            let path = entry?.path();
            if path.extension().is_none_or(|e| e != "json") {
                continue;
            }
            ensure!(
                fs::symlink_metadata(&path)?.file_type().is_file(),
                "event segment must be a regular file"
            );
            let segment: Segment = serde_json::from_slice(&fs::read(&path)?)
                .with_context(|| format!("invalid event segment {}", path.display()))?;
            ensure!(
                matches!(segment.version, 1..=4),
                "unsupported event segment version {}",
                segment.version
            );
            ensure!(
                segment.events.iter().all(|e| e.version <= segment.version),
                "event version exceeds segment version"
            );
            events.extend(segment.events);
        }
        projection::union(&self.repository, events)
    }
    /// Segments remain immutable; the lock also serializes assessment preconditions.
    pub fn append(&self, events: &[Event]) -> Result<usize> {
        self.append_checked(|_| Ok((events.to_vec(), ())))
            .map(|(count, ())| count)
    }

    pub fn append_checked<T>(
        &self,
        prepare: impl FnOnce(&BTreeMap<EventId, Event>) -> Result<(Vec<Event>, T)>,
    ) -> Result<(usize, T)> {
        fs::create_dir_all(&self.directory)?;
        let lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(self.directory.with_extension("lock"))?;
        lock.lock().context("cannot lock knowledge journal")?;
        let existing = self.read()?;
        let (events, result) = prepare(&existing)?;
        let combined = projection::union(
            &self.repository,
            existing.values().cloned().chain(events.iter().cloned()),
        )?;
        projection::reduce(&combined)?;
        let missing: Vec<_> = combined
            .into_iter()
            .filter(|(id, _)| !existing.contains_key(id))
            .map(|(_, e)| e)
            .collect();
        if missing.is_empty() {
            return Ok((0, result));
        }
        let count = missing.len();
        fs::create_dir_all(&self.directory)?;
        let mut temp = tempfile::Builder::new()
            .prefix(".pending-")
            .tempfile_in(&self.directory)?;
        temp.write_all(&serde_json::to_vec(&Segment {
            version: missing.iter().map(|e| e.version).max().unwrap_or(1),
            events: missing,
        })?)?;
        temp.as_file().sync_all()?;
        let destination = self
            .directory
            .join(format!("{}.json", uuid::Uuid::now_v7()));
        temp.persist_noclobber(destination).map_err(|e| e.error)?;
        sync_directory(&self.directory)?;
        Ok((count, result))
    }
}

fn sync_directory(path: &Path) -> Result<()> {
    #[cfg(unix)]
    fs::File::open(path)?.sync_all()?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}
