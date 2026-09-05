use std::{
    io::{self, Write},
    path::Path,
};

use anyhow::{Context, ensure};

use crate::{analysis, source};

pub fn run(file: &Path) -> anyhow::Result<()> {
    ensure!(
        file.extension().is_some_and(|ext| ext == "rs"),
        "unsupported Rust source file {}",
        file.display()
    );
    let path = file
        .to_str()
        .with_context(|| format!("source path is not UTF-8: {}", file.display()))?;
    let analysis = analysis::extract(source::read(Path::new("."), path)?)
        .with_context(|| format!("cannot analyze {}", file.display()))?;
    io::stdout()
        .lock()
        .write_all(analysis::report(&analysis).as_bytes())?;
    Ok(())
}
