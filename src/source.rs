pub(crate) mod normalized;
pub(crate) mod observation;
pub(crate) mod walk;
use std::fs;
use std::path::Path;

use anyhow::Context;

#[derive(Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SourceFile {
    pub path: String,
    pub text: String,
}

pub fn read(root: &Path, path: &str) -> anyhow::Result<SourceFile> {
    let bytes =
        fs::read(root.join(path)).with_context(|| format!("cannot read source file {path}"))?;

    let text = String::from_utf8(bytes)
        .with_context(|| format!("source file {path} is not valid UTF-8"))?;

    Ok(SourceFile {
        path: path.to_owned(),
        text,
    })
}

#[cfg(test)]
#[path = "../tests/unit/source.rs"]
mod tests;

/// Generated files have no source/resolver meaning, even when explicitly included.
pub(crate) fn operational(path: &Path) -> bool {
    let text = path.to_string_lossy().replace('\\', "/");
    let Some(path) = text.strip_prefix(".mimirs/") else {
        return false;
    };
    ["status-owners", "watch", "knowledge/repositories"]
        .iter()
        .any(|dir| path == *dir || path.starts_with(&format!("{dir}/")))
        || ["index.db", "staging.db"]
            .iter()
            .any(|name| path == *name || path.starts_with(&format!("{name}-")))
        || matches!(
            path,
            "status" | "status.lock" | "index.lock" | "knowledge/settings.lock"
        )
        || path.starts_with(".tmp")
        || path.starts_with("knowledge/.tmp")
}
