use anyhow::Result;
use clap::{Parser, Subcommand};

mod analysis;
mod commands;
mod config;
mod embedding;
mod retrieval;
mod source;
mod storage;

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

    /// Inspect source and available syntax analysis without project setup.
    Inspect {
        file: std::path::PathBuf,
        /// Read saved analysis without reading the current source.
        #[arg(long)]
        stored: bool,
        /// Preview raw source chunks and their context without loading a model.
        #[arg(long)]
        source_chunks: bool,
    },

    /// Index current directory with config defined in .mimirs folder.
    Index,

    /// Search query with limit.
    Search {
        /// Caller-distilled intent, preserving supplied identifiers and constraints.
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
            source_chunks,
        } => commands::inspect::run(&file, stored, source_chunks),
        Command::Init => commands::init::run(),
        Command::Index => commands::index::run(),
        Command::Search { query, limit } => commands::search::run(&query, limit),
    }
}

#[cfg(test)]
#[path = "../tests/support/mod.rs"]
mod test_support;
