use clap::Args;

use crate::indexing::index_project;

#[derive(Args)]
pub struct Options {}

pub fn run(_options: Options) -> anyhow::Result<()> {
    let root = std::env::current_dir()?;
    let summary = index_project(&root)?;
    println!(
        "{} files indexed: {} chunks, {} windows",
        summary.files, summary.chunks, summary.windows
    );
    println!(
        "{} unchanged, {} removed",
        summary.unchanged, summary.removed
    );
    println!(
        "skipped: {} not UTF-8, {} over 50 MB, {} unreadable",
        summary.not_text, summary.too_large, summary.unreadable
    );
    Ok(())
}
