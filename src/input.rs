//! Shared CLI/MCP transport decoding for saved maintenance responses.
use crate::knowledge::assessment::maintenance::{ReadRequest, Reference};
use anyhow::Result;
use serde_json::Value;
/// Accept either a complete maintenance response or its assessment object.
pub fn read_reference(path: &std::path::Path) -> Result<Reference> {
    let value: Value = serde_json::from_slice(&std::fs::read(path)?)?;
    parse_reference(value)
}

pub fn parse_reference(value: Value) -> Result<Reference> {
    Ok(serde_json::from_value(
        value.get("assessment").cloned().unwrap_or(value),
    )?)
}

pub(crate) fn maintenance(mut value: Value) -> Result<ReadRequest> {
    if let Some(reference) = value.get_mut("assessment")
        && let Some(inner) = reference.get("assessment")
    {
        *reference = inner.clone();
    }
    Ok(serde_json::from_value(value)?)
}
