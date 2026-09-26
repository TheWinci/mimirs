use anyhow::Context;
use clap::Args;

use crate::chunk::chunk;
use crate::config::Config;
use crate::discover::discover;
use crate::embed;
use crate::files::read::read_text;

#[derive(Args)]
pub struct Options {}

pub fn run(_options: Options) -> anyhow::Result<()> {
    let root = std::env::current_dir()?;
    let config = Config::load(&root.join(".mimirs/config.toml"))?;
    let model_files = embed::cached_files(&embed::cache_dir()?)
        .context("The embedding model is not downloaded; run `mimirs init` first")?;
    let tokenizer = embed::load_tokenizer(&model_files.tokenizer)?;

    let discovery = discover(&root, &config)?;
    for error in &discovery.errors {
        eprintln!("{error}");
    }

    let mut indexed_files = 0;
    let mut chunk_count = 0;
    let mut window_count = 0;
    let mut not_text = 0;
    let mut unreadable = 0;
    for file in &discovery.files {
        let text = match read_text(&root.join(&file.path)) {
            Ok(Some(text)) => text,
            Ok(None) => {
                not_text += 1;
                continue;
            }
            Err(error) => {
                eprintln!("Could not read {}: {error}", file.path.display());
                unreadable += 1;
                continue;
            }
        };
        let chunks = chunk(&text, &tokenizer)?;
        indexed_files += 1;
        chunk_count += chunks.len();
        window_count += chunks
            .iter()
            .map(|chunk| chunk.windows.len())
            .sum::<usize>();
    }

    println!("{indexed_files} files: {chunk_count} chunks, {window_count} windows");
    println!(
        "skipped: {not_text} not UTF-8, {} over 50 MB, {unreadable} unreadable",
        discovery.skipped_too_large
    );
    Ok(())
}
