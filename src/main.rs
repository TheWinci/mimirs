use anyhow::Result;
use clap::{Parser, Subcommand};

mod commands;

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
    Init {
        /// Skip creating .gitignore file
        #[arg(long)]
        no_gitignore: bool,
    },

    /// Index current directory with config defined in .mimirs folder.
    Index {
        /// Should watch and update scope defined in the config.
        #[arg(long)]
        watch: bool,
    },

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
        Command::Init { no_gitignore } => commands::init::run(no_gitignore)?,
        Command::Index { watch } => commands::index::run(watch)?,
        Command::Search { query, limit } => commands::search::run(&query, limit)?,
    }

    Ok(())
}
