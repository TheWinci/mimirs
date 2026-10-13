use std::path::PathBuf;
use std::sync::Arc;
use std::thread;

use clap::Args;
use tokio::sync::oneshot;

use crate::indexing::{Summary, index_project};
use crate::lock;
use crate::signals;
use crate::status::Status;

#[derive(Args)]
pub struct Options {}

/// How an index run ended.
enum Ending {
    Indexed(Summary),
    Signal(&'static str),
}

pub fn run(_options: Options) -> anyhow::Result<()> {
    let root = std::env::current_dir()?;
    // Taken before the model loads, so a blocked run fails at once.
    let Some(_writer_lock) = lock::try_take(&root)? else {
        anyhow::bail!("another mimirs process is indexing this project");
    };
    let status = Arc::new(Status::new(&root));
    status.hold_lock();
    Status::record_panics(Arc::clone(&status));
    status.catching_up();

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let ending = runtime.block_on(index_until_stopped(root, Arc::clone(&status)));
    // Dropping the runtime would wait for the indexing thread after a signal.
    runtime.shutdown_background();
    let summary = match ending {
        Ok(Ending::Indexed(summary)) => summary,
        Ok(Ending::Signal(signal)) => {
            status.stopped(signal);
            return Ok(());
        }
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

/// Index on a plain thread while this one waits for a stop signal, so a signal
/// can end the run at any point. Each file is its own transaction, so stopping
/// mid-run keeps every file written so far.
async fn index_until_stopped(root: PathBuf, status: Arc<Status>) -> anyhow::Result<Ending> {
    let (indexed_sender, indexed_receiver) = oneshot::channel();
    thread::spawn(move || {
        let indexed = index_project(&root, &mut |done, total| status.progress(done, total));
        let _ = indexed_sender.send(indexed);
    });
    tokio::select! {
        indexed = indexed_receiver => {
            // A panic drops the sender without a result; the panic hook has
            // already recorded its message.
            let summary = indexed.unwrap_or_else(|_| Err(anyhow::anyhow!("the indexer panicked")))?;
            Ok(Ending::Indexed(summary))
        }
        signal = signals::wait_for_stop() => Ok(Ending::Signal(signal?)),
    }
}
