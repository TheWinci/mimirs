use std::path::Path;

/// Read a file as text. Returns `None` when its bytes are not valid UTF-8.
pub fn read_text(path: &Path) -> anyhow::Result<Option<String>> {
    let bytes = std::fs::read(path)?;
    Ok(String::from_utf8(bytes).ok())
}
