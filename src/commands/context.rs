use crate::{context::task, embedding, knowledge::assessment::query, retrieval::query::Retriever};
use anyhow::Result;
use clap::Args;
use std::{
    io::{self, Write},
    path::PathBuf,
};

#[derive(Args)]
pub struct Options {
    /// Caller-distilled task query; preserves the source retrieval query verbatim.
    query: String,
    /// Consume existing knowledge by default; off bypasses all knowledge reads.
    #[arg(long, value_enum)]
    knowledge: Option<crate::config::KnowledgeMode>,
    #[arg(long, default_value = ".")]
    root: PathBuf,
    /// Logical knowledge identity. Source remains available when this is absent.
    #[arg(long)]
    repository: Option<String>,
    #[arg(long)]
    state: Option<PathBuf>,
    #[arg(long)]
    default_branch: Option<String>,
    #[arg(long, default_value_t = 5)]
    limit: usize,
    #[arg(long, default_value_t = query::DEFAULT_LIMIT)]
    knowledge_limit: usize,
    /// Complete JSON response including UTF-8, escaping and newline.
    #[arg(long, default_value_t = task::DEFAULT_BYTES)]
    max_bytes: usize,
}
pub fn run(options: Options) -> Result<()> {
    let value = task::execute(
        &task::Request {
            root: &options.root,
            query: &options.query,
            knowledge: options.knowledge,
            source_limit: options.limit,
            knowledge_limit: options.knowledge_limit,
            max_bytes: options.max_bytes,
            repository: options.repository.as_deref(),
            state: options.state.as_deref(),
            default_branch: options.default_branch.as_deref(),
        },
        &mut Retriever::default(),
        embedding::production,
    )?;
    let mut stdout = io::stdout().lock();
    serde_json::to_writer(&mut stdout, &value)?;
    writeln!(stdout)?;
    Ok(())
}
