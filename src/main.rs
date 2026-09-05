use anyhow::Result;
use clap::{Parser, Subcommand};

mod analysis;
mod chunk;
mod commands;
mod config;
mod embedding;
#[allow(dead_code)] // Used by indexing once the document pipeline is complete.
mod retrieval;
mod source;
mod storage;
mod window;

/// mimirs CLI
#[derive(Parser)]
#[command(name = "mimirs", version, about)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Create an initial config for mimirs in .mimirs folder.
    Init,

    /// Inspect Rust syntax without project setup.
    Inspect {
        file: std::path::PathBuf,
        /// Read saved analysis without reading the current source.
        #[arg(long)]
        stored: bool,
        /// Preview evidence descriptions without loading an embedding model.
        #[arg(long)]
        documents: bool,
    },

    /// Index current directory with config defined in .mimirs folder.
    Index,

    /// Search query with limit.
    Search {
        /// Text that will be used to search the index.
        query: String,

        /// Number of top results to return.
        #[arg(long, default_value_t = 5)]
        limit: usize,
    },
}

fn main() -> Result<()> {
    let cli = Cli::parse();

    match cli.command {
        Command::Inspect {
            file,
            stored,
            documents,
        } => commands::inspect::run(&file, stored, documents),
        Command::Init => commands::init::run(),
        Command::Index => commands::index::run(),
        Command::Search { query, limit } => commands::search::run(&query, limit),
    }
}

#[cfg(test)]
#[path = "../tests/support/mod.rs"]
mod test_support;
