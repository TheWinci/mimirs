use anyhow::Result;
use clap::{Parser, Subcommand};

mod analysis;
mod commands;
mod config;
mod embedding;
mod profiling;
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
    Index {
        /// Write exclusive phase timings and counters to a new JSON file.
        #[arg(long)]
        profile: Option<std::path::PathBuf>,
        /// Use a separate embedding model cache for this run.
        #[arg(long)]
        model_cache: Option<std::path::PathBuf>,
    },

    /// Search indexed source and documentation.
    Search {
        /// Caller-distilled intent, preserving supplied identifiers and constraints.
        query: String,

        /// Number of source files to return, between 1 and 100.
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
        Command::Index {
            profile,
            model_cache,
        } => commands::index::run(profile.as_deref(), model_cache),
        Command::Search { query, limit } => commands::search::run(&query, limit),
    }
}

#[cfg(test)]
#[path = "../tests/support/mod.rs"]
mod test_support;
