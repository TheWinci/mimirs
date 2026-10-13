use anyhow::Result;
use clap::{Parser, Subcommand};

mod chunk;
mod commands;
mod config;
mod discover;
mod embed;
mod excerpt;
mod files;
mod indexing;
mod keywords;
mod lock;
mod names;
mod rank;
mod render;
mod signals;
mod status;
mod store;
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
    /// Analyse current mimirs state.
    Doctor(Box<commands::doctor::Options>),

    /// Create an initial config.toml in .mimirs folder.
    Init(Box<commands::init::Options>),

    /// Index current directory with config defined in .mimirs folder.
    Index(Box<commands::index::Options>),

    /// Learn something useful to be preserved.
    Learn(Box<commands::learn::Options>),

    /// Retrieve context for a distilled query.
    Context(Box<commands::context::Options>),

    /// Serve MCP over stdio and keep the index current while the session runs.
    Mcp(Box<commands::mcp::Options>),
}

fn main() -> Result<()> {
    let cli = Cli::parse();

    match cli.command {
        Command::Doctor(options) => commands::doctor::run(*options)?,
        Command::Init(options) => commands::init::run(*options)?,
        Command::Index(options) => commands::index::run(*options)?,
        Command::Learn(options) => commands::learn::run(*options)?,
        Command::Context(options) => commands::context::run(*options)?,
        Command::Mcp(options) => commands::mcp::run(*options)?,
    }

    Ok(())
}
