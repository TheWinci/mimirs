use anyhow::Result;
use clap::{Parser, Subcommand};

mod analysis;
mod channel;
mod collation;
mod commands;
mod config;
mod context;
mod embedding;
mod files;
mod git;
mod index;
mod input;
mod knowledge;
mod mcp;
mod profiling;
mod retrieval;
mod source;
mod status;
mod storage;
mod watch;

/// mimirs CLI
#[derive(Parser)]
#[command(name = "mimirs", version, about)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Read .mimirs/status without loading a model or assessing source.
    Status(commands::status::Options),
    /// Reconcile source, vectors, relationships and mechanical knowledge state.
    Watch(Box<watch::Options>),
    /// Serve local context and explicit knowledge tools over MCP stdio.
    Mcp(Box<mcp::Options>),
    /// Preserve, exchange and reconcile learned engineering knowledge.
    Knowledge(Box<commands::knowledge::Options>),
    /// Retrieve indexed source and relevant knowledge in one bounded response.
    Context(Box<commands::context::Options>),
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

    /// Resolve project imports, re-exports and calls without loading a model.
    Relationships {
        /// Read the validated watch graph built from indexed analysis.
        #[arg(long)]
        indexed: bool,
        /// Print complete relationships and source evidence as JSON.
        #[arg(long)]
        json: bool,
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
        /// Source presentation. Full preserves the original search interface.
        #[arg(long, value_enum, default_value = "full")]
        output: commands::search::Output,
    },
}

fn main() -> Result<()> {
    let cli = Cli::parse();

    match cli.command {
        Command::Status(options) => commands::status::run(options),
        Command::Watch(options) => watch::run(*options),
        Command::Mcp(options) => mcp::run(*options),
        Command::Context(options) => commands::context::run(*options),
        Command::Knowledge(options) => commands::knowledge::run(*options),
        Command::Inspect {
            file,
            stored,
            source_chunks,
        } => commands::inspect::run(&file, stored, source_chunks),
        Command::Relationships { json, indexed } => commands::relationships::run(json, indexed),
        Command::Init => commands::init::run(),
        Command::Index {
            profile,
            model_cache,
        } => commands::index::run(profile.as_deref(), model_cache),
        Command::Search {
            query,
            limit,
            output,
        } => commands::search::run(&query, limit, output),
    }
}

#[cfg(test)]
#[path = "../tests/support/mod.rs"]
mod test_support;
