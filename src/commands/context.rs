use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::Context;
use clap::Args;

use crate::config::Config;
use crate::embed::{self, Embedder};
use crate::rank::rank;
use crate::render::render;
use crate::store::Store;

/// Windows compared with the query; enough to fill a map of 20 files.
const NEAREST_WINDOWS: usize = 200;
/// Files listed in the map.
const MAP_FILES: usize = 20;

#[derive(Args)]
pub struct Options {
    /// What you need context for, as a short description of the behavior or question.
    pub query: String,

    /// Most bytes to print.
    #[arg(long, default_value_t = 16_000)]
    pub budget: usize,
}

pub fn run(options: Options) -> anyhow::Result<()> {
    let root = std::env::current_dir()?;
    print!("{}", answer(&root, &options.query, options.budget)?);
    Ok(())
}

/// Search the project's index for `query` and render the file map and excerpts.
/// Reads only what is committed; it never indexes or waits for an index run.
fn answer(root: &Path, query: &str, budget: usize) -> anyhow::Result<String> {
    let store = Store::open_existing(&root.join(".mimirs/index.db"))?;
    anyhow::ensure!(
        store.file_count()? > 0,
        "The index is empty; run `mimirs index` first"
    );
    let model_files = embed::cached_files(&embed::cache_dir()?)
        .context("The embedding model is not downloaded; run `mimirs init` first")?;
    let config = Config::load(&root.join(".mimirs/config.toml"))?;
    let mut embedder = Embedder::load(&model_files, config.threads)?;

    let query_vector = embedder.embed(query)?;
    let hits = store.nearest(&query_vector, NEAREST_WINDOWS)?;
    let files = rank(hits, MAP_FILES);

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
        let error = answer(project.path(), "anything", 16_000).unwrap_err();
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
        crate::commands::index::index_project(root)?;

        let output = answer(root, "renew an expiring login token", 16_000)?;
        let map = output
            .split("Relevant files\n")
            .nth(1)
            .context("missing file map")?;
        assert!(map.starts_with("  1. src/auth.rs:"), "{output}");
        Ok(())
    }
}
