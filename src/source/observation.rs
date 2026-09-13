//! One contained raw-byte observation, shared by all knowledge read paths.
use crate::files::{fingerprint, validate_path};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::{io::ErrorKind, path::Path};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Observation {
    pub sha256: Option<String>,
    pub bytes: Option<usize>,
    pub problem: Option<String>,
}

#[derive(Clone)]
pub struct Observed {
    pub metadata: Observation,
    pub bytes: Option<Vec<u8>>,
}
impl Observed {
    pub fn read(root: &Path, path: &str) -> Self {
        match read_bytes(root, path) {
            Ok(bytes) => Self::from_bytes(bytes),
            Err(error) => Self {
                metadata: Observation {
                    sha256: None,
                    bytes: None,
                    problem: Some(format!("{error:#}")),
                },
                bytes: None,
            },
        }
    }
    fn from_bytes(bytes: Option<Vec<u8>>) -> Self {
        let metadata = match &bytes {
            Some(bytes) => Observation {
                sha256: Some(fingerprint(bytes)),
                bytes: Some(bytes.len()),
                problem: std::str::from_utf8(bytes)
                    .err()
                    .map(|_| "not valid UTF-8".into()),
            },
            None => Observation {
                sha256: None,
                bytes: None,
                problem: Some("missing".into()),
            },
        };
        Self { metadata, bytes }
    }
    pub fn source(&self, path: &str) -> Option<crate::source::SourceFile> {
        Some(crate::source::SourceFile {
            path: path.into(),
            text: std::str::from_utf8(self.bytes.as_ref()?).ok()?.into(),
        })
    }
}
impl From<Option<crate::source::SourceFile>> for Observed {
    fn from(source: Option<crate::source::SourceFile>) -> Self {
        Self::from_bytes(source.map(|s| s.text.into_bytes()))
    }
}
/// Read contained working bytes without requiring a Git checkout.
pub(crate) fn read_bytes(root: &Path, path: &str) -> Result<Option<Vec<u8>>> {
    validate_path(path)?;
    let resolved = match root.join(path).canonicalize() {
        Ok(path) => path,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e).context("cannot resolve evidence path"),
    };
    ensure!(
        resolved.starts_with(root) && !resolved.starts_with(root.join(".git")),
        "evidence path escapes repository: {path}"
    );
    ensure!(resolved.is_file(), "evidence is not a file: {path}");
    // Read the resolved path so a symlink change cannot redirect this read.
    Ok(Some(std::fs::read(&resolved).with_context(|| {
        format!("cannot read source file {path}")
    })?))
}
