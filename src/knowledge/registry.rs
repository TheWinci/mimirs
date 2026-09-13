use super::{journal::Journal, model::*};
use anyhow::Result;
use std::path::Path;

pub trait Registry {
    fn events(&self) -> Result<Vec<Event>>;
    fn publish(&self, events: &[Event]) -> Result<usize>;
}

pub struct LocalDirectoryRegistry {
    journal: Journal,
}
impl LocalDirectoryRegistry {
    pub fn new(root: &Path, repository: &RepositoryId) -> Self {
        Self {
            journal: Journal::new(
                root.join("repositories")
                    .join(super::fingerprint(repository.0.as_bytes()))
                    .join("events"),
                repository,
            ),
        }
    }
}
impl Registry for LocalDirectoryRegistry {
    fn events(&self) -> Result<Vec<Event>> {
        Ok(self.journal.read()?.into_values().collect())
    }
    fn publish(&self, events: &[Event]) -> Result<usize> {
        self.journal.append(events)
    }
}
