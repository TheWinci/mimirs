use std::fs::{File, OpenOptions, TryLockError};
use std::path::Path;

use anyhow::Result;

/// Proof that this process is the project's only index writer. The OS releases
/// the lock when the file closes, which also happens when the process dies.
pub struct WriterLock {
    _file: File,
}

/// Take the writer lock on `root/.mimirs/writer.lock`, or return `None` when
/// another process holds it.
pub fn try_take(root: &Path) -> Result<Option<WriterLock>> {
    let file = open_lock_file(root)?;
    match file.try_lock() {
        Ok(()) => Ok(Some(WriterLock { _file: file })),
        Err(TryLockError::WouldBlock) => Ok(None),
        Err(TryLockError::Error(error)) => Err(error.into()),
    }
}

fn open_lock_file(root: &Path) -> Result<File> {
    let folder = root.join(".mimirs");
    anyhow::ensure!(
        folder.is_dir(),
        "Could not find {}; run `mimirs init` first",
        folder.display()
    );
    // The lock lives in the kernel, not in the file, so its contents never matter.
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(folder.join("writer.lock"))?;
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_holder_at_a_time() -> Result<()> {
        let project = tempfile::tempdir()?;
        std::fs::create_dir(project.path().join(".mimirs"))?;

        let first = try_take(project.path())?;
        assert!(first.is_some());
        assert!(try_take(project.path())?.is_none());

        drop(first);
        assert!(try_take(project.path())?.is_some());
        Ok(())
    }

    #[test]
    fn needs_an_initialized_project() -> Result<()> {
        let project = tempfile::tempdir()?;
        let error = try_take(project.path()).err().expect("no .mimirs folder");
        assert!(error.to_string().contains("mimirs init"));
        Ok(())
    }
}
