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
