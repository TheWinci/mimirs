use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::Context;
use clap::Args;

use crate::embed::{self, Embedder};
use crate::excerpt::{ShownFile, show_file};
use crate::keywords;
use crate::rank::rank;
use crate::render::render;
use crate::store::Store;

/// Windows compared with the query; enough to fill the default map of 20 files.
const NEAREST_WINDOWS: usize = 200;
/// Keyword matches fused with the nearest windows.
const KEYWORD_CHUNKS: usize = 200;

#[derive(Args)]
pub struct Options {
    /// What you need context for, as a short description of the behavior or question.
    pub query: String,

    /// Most bytes to print.
    #[arg(long, default_value_t = 16_000)]
    pub budget: usize,

    /// Most files to list in the map.
    #[arg(long, default_value_t = 20)]
    pub files: usize,
}

pub fn run(options: Options) -> anyhow::Result<()> {
    let root = std::env::current_dir()?;
    print!(
        "{}",
        answer(&root, &options.query, options.budget, options.files)?
    );
    Ok(())
}

/// Search the project's index for `query` and render the file map and excerpts.
/// Reads only what is committed; it never indexes or waits for an index run.
fn answer(root: &Path, query: &str, budget: usize, max_files: usize) -> anyhow::Result<String> {
    let store = Store::open_existing(&root.join(".mimirs/index.db"))?;
    anyhow::ensure!(
        store.file_count()? > 0,
        "The index is empty; run `mimirs index` first"
    );
    let model_files = embed::cached_files(&embed::cache_dir()?)
        .context("The embedding model is not downloaded; run `mimirs init` first")?;
    // One query needs one model instance; loading more would only slow startup.
    let mut embedder = Embedder::load(&model_files, 1)?;

    let query_vector = embedder.embed(query)?;
    let vector_hits = store.nearest(&query_vector, NEAREST_WINDOWS)?;
    let keyword_hits = match keywords::match_expression(query) {
        Some(expression) => store.keyword_matches(&expression, KEYWORD_CHUNKS)?,
        None => Vec::new(),
    };
    let ranked = rank(vector_hits, keyword_hits, max_files);
    let mut files: Vec<ShownFile> = Vec::new();
    for file in &ranked {
        let stored = store.stored_file(&file.path)?;
        files.push(show_file(&file.path, &stored, &file.chunk_ids));
    }

    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs() as i64;
    let index_age = store
        .last_finished_run()?
        .map(|finished| now.saturating_sub(finished).max(0) as u64);
    Ok(render(index_age, &files, budget))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use std::fs;

    #[test]
    fn a_project_without_an_index_is_told_to_run_index() -> anyhow::Result<()> {
        let project = tempfile::tempdir()?;
        let error = answer(project.path(), "anything", 16_000, 20).unwrap_err();
        assert!(error.to_string().contains("mimirs index"));
        Ok(())
    }

    #[test]
    #[ignore = "downloads and runs the real model"]
    fn a_query_about_one_file_ranks_it_first() -> anyhow::Result<()> {
        embed::download(&embed::cache_dir()?)?;
        let project = tempfile::tempdir()?;
        let root = project.path();
        fs::create_dir_all(root.join(".mimirs"))?;
        fs::write(
            root.join(".mimirs/config.toml"),
            Config::default().to_toml()?,
        )?;
        fs::create_dir_all(root.join("src"))?;
        fs::write(
            root.join("src/auth.rs"),
            "/// Refresh the access token shortly before it expires.\nfn refresh_access_token(session: &mut Session) {}\n",
        )?;
        fs::write(
            root.join("src/recipes.rs"),
            "/// Boil the pasta for nine minutes, then drain it.\nfn cook_pasta() {}\n",
        )?;
        fs::create_dir_all(root.join("docs"))?;
        fs::write(
            root.join("docs/garden.md"),
            "# Garden\n\nWater the tomatoes every morning.\n",
        )?;
        crate::indexing::index_project(root)?;

        let output = answer(root, "renew an expiring login token", 16_000, 20)?;
        let map = output
            .split("Relevant files\n")
            .nth(1)
            .context("missing file map")?;
        assert!(map.starts_with("  1. src/auth.rs:"), "{output}");
        Ok(())
    }
}
