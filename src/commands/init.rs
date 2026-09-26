use clap::Args;
use std::fs;
use std::io::ErrorKind;
use std::path::Path;

use crate::config::Config;
use crate::embed::{self, ModelFiles};
use crate::files::write::write_default;

/// Contents written to `.mimirs/.gitignore`, making the directory ignore itself.
const IGNORE_CONTENTS: &str = "*\n";

#[derive(Args)]
pub struct Options {}

pub fn run(_options: Options) -> anyhow::Result<()> {
    let root = Path::new(".mimirs");

    let created_dir = match fs::create_dir(root) {
        Ok(()) => {
            println!("{} created", root.display());
            true
        }
        Err(e) if e.kind() == ErrorKind::AlreadyExists => {
            println!("{} already exists", root.display());
            false
        }
        Err(e) => return Err(e.into()),
    };

    write_default(&root.join(".gitignore"), IGNORE_CONTENTS, created_dir)?;

    write_default(
        &root.join("config.toml"),
        &Config::default().to_toml()?,
        created_dir,
    )?;

    prepare_model()
}

/// Make sure the pinned model is in the machine cache and say where it is.
fn prepare_model() -> anyhow::Result<()> {
    let cache = embed::cache_dir()?;
    if let Some(files) = embed::cached_files(&cache) {
        println!(
            "model already cached in {} ({})",
            cache.display(),
            size_of(&files)?
        );
        return Ok(());
    }

    println!("downloading model into {}", cache.display());
    let files = embed::download(&cache)?;
    println!("model cached in {} ({})", cache.display(), size_of(&files)?);
    Ok(())
}

fn size_of(files: &ModelFiles) -> anyhow::Result<String> {
    let bytes = fs::metadata(&files.model)?.len() + fs::metadata(&files.tokenizer)?.len();
    Ok(format!("{:.1} MB", bytes as f64 / 1_000_000.0))
}
