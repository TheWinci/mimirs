use std::path::{Path, PathBuf};
use std::thread;

use clap::Args;
use rmcp::ServiceExt;
use rmcp::model::{Implementation, ServerCapabilities, ServerConfig};
use tokio::sync::oneshot;

use crate::indexing::index_project;
use crate::lock;

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

    let summary = index_project(root)?;
    eprintln!(
        "mimirs: caught up: {} files indexed, {} unchanged, {} removed",
        summary.files, summary.unchanged, summary.removed
    );

    // Hold the lock until the process exits.
    loop {
        thread::park();
    }
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
