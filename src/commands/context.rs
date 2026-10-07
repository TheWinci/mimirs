use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::Context;
use clap::Args;

use crate::embed::{self, Embedder};
use crate::excerpt::{ShownFile, show_file};
use crate::keywords;
use crate::probes::Probes;
use crate::rank::{PROBE_VECTOR_WEIGHT, Signals, rank};
use crate::references;
use crate::render::render;
use crate::store::{Hit, Store};

/// Windows compared with the query; enough to fill the default map of 20 files.
const NEAREST_WINDOWS: usize = 200;
/// Keyword matches fused with the nearest windows.
const KEYWORD_CHUNKS: usize = 200;
/// Most docs in the doc map, after the source files.
const MAX_DOCS: usize = 5;

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
    let probes = Probes::from_env()?;
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
    let mut vector_hits = store.nearest(&query_vector, NEAREST_WINDOWS)?;
    let expression = keywords::match_expression(query);
    let mut keyword_hits = match &expression {
        Some(expression) => store.keyword_matches(expression, KEYWORD_CHUNKS)?,
        None => Vec::new(),
    };

    // Score completion: a chunk found by one list gets its score in the other
    // too, so fusion compares every candidate on both measures.
    let vector_only = chunks_missing_from(&vector_hits, &keyword_hits);
    let keyword_only = chunks_missing_from(&keyword_hits, &vector_hits);
    if let Some(expression) = &expression {
        keyword_hits.extend(store.keyword_scores(expression, &vector_only)?);
    }
    vector_hits.extend(store.vector_scores(&query_vector, &keyword_only)?);

    let mut signals = Signals::default();
    if probes.vector_weight() {
        signals.vector_weight = PROBE_VECTOR_WEIGHT;
    }
    let mut ranking = rank(vector_hits, keyword_hits, &signals);
    if probes.doc_references() {
        references::expand(&mut ranking, &store)?;
    }
    ranking.files.truncate(max_files);
    ranking.docs.truncate(MAX_DOCS);
    let mut files: Vec<ShownFile> = Vec::new();
    for file in &ranking.files {
        let stored = store.stored_file(&file.path)?;
        files.push(show_file(&file.path, &stored, &file.chunk_ids));
    }
    let mut docs: Vec<ShownFile> = Vec::new();
    for doc in &ranking.docs {
        let stored = store.stored_file(&doc.path)?;
        docs.push(show_file(&doc.path, &stored, &doc.chunk_ids));
    }

    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs() as i64;
    let index_age = store
        .last_finished_run()?
        .map(|finished| now.saturating_sub(finished).max(0) as u64);
    Ok(render(index_age, &files, &docs, budget))
}

/// The distinct chunks in `hits` that `other` does not have, in `hits` order.
fn chunks_missing_from(hits: &[Hit], other: &[Hit]) -> Vec<i64> {
    let mut missing: Vec<i64> = Vec::new();
    for hit in hits {
        let in_other = other
            .iter()
            .any(|other_hit| other_hit.chunk_id == hit.chunk_id);
        if !in_other && !missing.contains(&hit.chunk_id) {
            missing.push(hit.chunk_id);
        }
    }
    missing
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
        crate::indexing::index_project(root, None)?;

        let output = answer(root, "renew an expiring login token", 16_000, 20)?;
        let map = output
            .split("Relevant files\n")
            .nth(1)
            .context("missing file map")?;
        assert!(map.starts_with("  1. src/auth.rs:"), "{output}");
        Ok(())
    }
}
