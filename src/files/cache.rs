//! Atomic disposable watch-view files, kept separate from the knowledge journal.
use anyhow::Result;
use serde_json::Value;
use std::{fs, io::Write, path::Path};
pub(crate) fn load(root: &Path, name: &str) -> Result<Option<Value>> {
    match fs::read(root.join(".mimirs/watch").join(name)) {
        Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}
pub(crate) fn remove(root: &Path, name: &str) -> Result<()> {
    match fs::remove_file(root.join(".mimirs/watch").join(name)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}
pub(crate) fn persist(root: &Path, name: &str, value: &Value) -> Result<bool> {
    let directory = root.join(".mimirs/watch");
    fs::create_dir_all(&directory)?;
    let ignore = directory.join(".gitignore");
    if !ignore.try_exists()? {
        fs::write(ignore, "*\n")?;
    }
    let path = directory.join(name);
    let bytes = serde_json::to_vec(value)?;
    if fs::read(&path).ok().as_deref() == Some(&bytes) {
        return Ok(false);
    }
    let mut temp = tempfile::NamedTempFile::new_in(&directory)?;
    temp.write_all(&bytes)?;
    temp.as_file().sync_all()?;
    temp.persist(path)?;
    fs::File::open(directory)?.sync_all()?;
    Ok(true)
}
