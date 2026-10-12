use clap::Args;

use crate::indexing::index_project;
use crate::lock;
use crate::status::Status;

#[derive(Args)]
pub struct Options {}

pub fn run(_options: Options) -> anyhow::Result<()> {
    let root = std::env::current_dir()?;
    // Taken before the model loads, so a blocked run fails at once.
    let Some(_writer_lock) = lock::try_take(&root)? else {
        anyhow::bail!("another mimirs process is indexing this project");
    };
    let status = Status::new(&root);
    status.hold_lock();
    status.catching_up();
    let summary = match index_project(&root, &mut |done, total| status.progress(done, total)) {
        Ok(summary) => summary,
        Err(error) => {
            status.error(&format!("{error:#}"));
            return Err(error);
        }
    };
    status.indexed(&summary);
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
