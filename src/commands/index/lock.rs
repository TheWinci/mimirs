//! OS-backed exclusion for indexing and abandoned-stage cleanup. The lock file
//! may remain after exit; ownership ends when the open descriptor closes.
use anyhow::{Context, Result};
use std::{
    fs::{File, OpenOptions},
    path::Path,
};

pub(super) fn acquire(root: &Path) -> Result<File> {
    let directory = root.join(".mimirs");
    std::fs::create_dir_all(&directory)?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(directory.join("index.lock"))?;
    file.try_lock()
        .context("another index writer is active for this project")?;
    Ok(file)
}

#[cfg(test)]
#[path = "../../../tests/unit/commands/index/lock.rs"]
mod tests;
