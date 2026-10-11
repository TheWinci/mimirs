use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};

use clap::Args;
use rmcp::ServiceExt;
use rmcp::model::{Implementation, ServerCapabilities, ServerConfig};
use tokio::sync::oneshot;

use crate::indexing::{Indexer, Summary};
use crate::lock;
use crate::watch::{self, Change};

/// How long changes must stop before a catch-up runs, so one save that fires
/// several events costs one catch-up.
const QUIET: Duration = Duration::from_millis(200);
/// How often a full catch-up runs anyway. Some platforms lose events without
/// saying so, and folders past the watch limit send none.
const TIMED_CATCH_UP: Duration = Duration::from_secs(60);

#[derive(Args)]
pub struct Options {
    /// Project to keep indexed; the current directory when omitted.
    #[arg(long)]
    root: Option<PathBuf>,
}

/// Serve MCP over stdin and stdout while a writer thread keeps the index
/// current. Ends when the client closes stdin or the writer fails.
pub fn run(options: Options) -> anyhow::Result<()> {
    let root = match options.root {
        Some(root) => root,
        None => std::env::current_dir()?,
    };
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let result = runtime.block_on(serve(root));
    // Dropping the runtime would wait for the task reading stdin, which only
    // ends when the client closes it.
    runtime.shutdown_background();
    result
}

async fn serve(root: PathBuf) -> anyhow::Result<()> {
    let (writer_sender, writer_receiver) = oneshot::channel();
    // A plain thread, not a tokio task: it may block on the lock for a whole
    // session, and the process must still exit when stdin closes.
    thread::spawn(move || {
        let _ = writer_sender.send(write_index(&root));
    });

    let session = async {
        let service = Server.serve(rmcp::transport::stdio()).await?;
        service.waiting().await?;
        anyhow::Ok(())
    };
    // The writer can fail before the client finishes the handshake.
    tokio::select! {
        ended = session => ended,
        written = writer_receiver => written?,
    }
}

/// Become the project's writer, then keep its index current. Returns only on
/// error; the process exiting releases the lock.
fn write_index(root: &Path) -> anyhow::Result<()> {
    let _writer_lock = match lock::try_take(root)? {
        Some(writer_lock) => writer_lock,
        None => {
            eprintln!("mimirs: another mimirs process is indexing; waiting for it to finish");
            lock::take(root)?
        }
    };

    let mut indexer = Indexer::load(root)?;
    let (change_sender, changes) = mpsc::channel();
    // Watching starts before the first catch-up, so a change made during it
    // still arrives as an event.
    let _watcher = watch::watch(root, indexer.config(), change_sender)?;
    let summary = indexer.catch_up()?;
    report(&summary);

    let mut next_timed_catch_up = Instant::now() + TIMED_CATCH_UP;
    // Each changed path waits for its own quiet period.
    let mut pending_paths: HashMap<PathBuf, Instant> = HashMap::new();
    let mut catch_up_after: Option<Instant> = None;
    let mut config_notice_at: Option<Instant> = None;
    loop {
        // A pending catch-up covers every path, so paths do not wake the loop then.
        let deadline = match catch_up_after {
            Some(catch_up_after) => catch_up_after.min(next_timed_catch_up),
            None => pending_paths
                .values()
                .copied()
                .fold(next_timed_catch_up, Instant::min),
        };
        match changes.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(Change::Path(path)) => {
                pending_paths.insert(path, Instant::now() + QUIET);
            }
            Ok(Change::Lost) => catch_up_after = Some(Instant::now() + QUIET),
            Ok(Change::Config) => {
                // One save fires several events; say it once.
                if config_notice_at.is_none_or(|at| at.elapsed() > Duration::from_secs(1)) {
                    eprintln!("mimirs: restart the session to apply config changes");
                    config_notice_at = Some(Instant::now());
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                let now = Instant::now();
                let timed = now >= next_timed_catch_up;
                if timed {
                    // A fixed schedule, so a file that never stops changing
                    // cannot hold off every catch-up.
                    next_timed_catch_up += TIMED_CATCH_UP;
                }
                let catch_up_due = timed || catch_up_after.is_some_and(|at| now >= at);
                if !catch_up_due {
                    if catch_up_after.is_some() {
                        continue;
                    }
                    let due_paths: Vec<PathBuf> = pending_paths
                        .extract_if(|_, quiet_until| *quiet_until <= now)
                        .map(|(path, _)| path)
                        .collect();
                    if due_paths.is_empty() {
                        continue;
                    }
                    if let Some(summary) = indexer.update_paths(&due_paths)? {
                        report_changes(&summary);
                        continue;
                    }
                }
                // The full walk covers every path still waiting.
                pending_paths.clear();
                catch_up_after = None;
                let summary = indexer.catch_up()?;
                report_changes(&summary);
            }
            Err(RecvTimeoutError::Disconnected) => anyhow::bail!("the file watcher stopped"),
        }
    }
}

/// Report a catch-up or update only when it changed the index; the timed
/// catch-up usually finds nothing.
fn report_changes(summary: &Summary) {
    if summary.files > 0 || summary.removed > 0 {
        report(summary);
    }
}

fn report(summary: &Summary) {
    eprintln!(
        "mimirs: caught up: {} files indexed, {} unchanged, {} removed",
        summary.files, summary.unchanged, summary.removed
    );
}

/// An MCP server with no tools; it exists so the client keeps the writer alive.
struct Server;

impl rmcp::ServerHandler for Server {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::default()).with_server_info(Implementation::new(
            env!("CARGO_PKG_NAME"),
            env!("CARGO_PKG_VERSION"),
        ))
    }
}
