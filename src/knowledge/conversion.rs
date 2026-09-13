//! Supported Git text conversion. Never execute user-defined clean/smudge filters.
use super::{checkout::Checkout, fingerprint, model::FileEvidence};
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use std::{io::Write, process::Stdio};

#[derive(Debug, Clone, Serialize)]
pub struct Unsupported {
    pub path: String,
    pub attribute: String,
}
impl std::fmt::Display for Unsupported {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "unsupported evidence conversion: Git {} attribute on '{}'",
            self.attribute, self.path
        )
    }
}
impl std::error::Error for Unsupported {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Committed {
    pub version: u32,
    pub blob_sha256: String,
    pub representation: Representation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Representation {
    CrLf,
    Unreconstructable,
}

impl Committed {
    pub fn validate(&self) -> Result<()> {
        ensure!(self.version == 1, "unsupported evidence conversion version");
        ensure!(
            self.blob_sha256.len() == 64 && self.blob_sha256.bytes().all(|b| b.is_ascii_hexdigit()),
            "invalid committed blob SHA-256"
        );
        Ok(())
    }
}

fn crlf(blob: &[u8]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(blob.len());
    for &byte in blob {
        if byte == b'\n' {
            bytes.push(b'\r');
        }
        bytes.push(byte);
    }
    bytes
}

/// Exact historical reconstruction is always checked against the observed hash.
pub fn reconstruct(evidence: &FileEvidence, blob: &[u8]) -> Option<Vec<u8>> {
    if fingerprint(blob) == evidence.sha256 {
        return Some(blob.to_vec());
    }
    let committed = evidence.committed.as_ref()?;
    if fingerprint(blob) != committed.blob_sha256 {
        return None;
    }
    let bytes = match committed.representation {
        Representation::CrLf => crlf(blob),
        Representation::Unreconstructable => return None,
    };
    (fingerprint(&bytes) == evidence.sha256).then_some(bytes)
}

/// Return commit membership and optional reconstruction metadata for these raw bytes.
pub fn inspect(checkout: &Checkout, path: &str, bytes: &[u8]) -> Result<(bool, Option<Committed>)> {
    let attrs = crate::git::command(&checkout.root)?
        .args([
            "check-attr",
            "-z",
            "text",
            "eol",
            "filter",
            "working-tree-encoding",
            "ident",
            "--",
            path,
        ])
        .output()?;
    ensure!(
        attrs.status.success(),
        "cannot inspect Git evidence conversion attributes"
    );
    let fields = attrs.stdout.split(|b| *b == 0).collect::<Vec<_>>();
    let mut values = std::collections::BTreeMap::new();
    for entry in fields.chunks_exact(3) {
        values.insert(
            std::str::from_utf8(entry[1])?,
            std::str::from_utf8(entry[2])?,
        );
    }
    let attr = |name| values.get(name).copied().unwrap_or("unspecified");
    for name in ["filter", "working-tree-encoding", "ident"] {
        if !matches!(attr(name), "unspecified" | "unset") {
            return Err(Unsupported {
                path: path.into(),
                attribute: name.into(),
            }
            .into());
        }
    }
    let blob = crate::git::command(&checkout.root)?
        .args(["show", &format!("{}:{path}", checkout.revision.commit)])
        .output()?;
    if !blob.status.success() {
        return Ok((false, None));
    }
    if blob.stdout == bytes {
        return Ok((true, None));
    }
    // Let Git decide text=auto, index-aware CRLF handling and binary heuristics.
    // Custom filters, encoding and ident were rejected before this invocation.
    let mut clean = crate::git::command(&checkout.root)?
        .args(["hash-object", "--path", path, "--stdin"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    clean.stdin.take().unwrap().write_all(bytes)?;
    let clean = clean.wait_with_output()?;
    ensure!(
        clean.status.success(),
        "unsupported evidence conversion: Git could not convert '{path}'"
    );
    let identity = crate::git::command(&checkout.root)?
        .args([
            "rev-parse",
            "--verify",
            &format!("{}:{path}", checkout.revision.commit),
        ])
        .output()?;
    ensure!(
        identity.status.success(),
        "cannot resolve committed evidence blob identity"
    );
    if clean.stdout != identity.stdout {
        return Ok((false, None));
    }
    Ok((
        true,
        Some(Committed {
            version: 1,
            blob_sha256: fingerprint(&blob.stdout),
            representation: if crlf(&blob.stdout) == bytes {
                Representation::CrLf
            } else {
                Representation::Unreconstructable
            },
        }),
    ))
}
