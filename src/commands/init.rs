use clap::Args;
use std::fs;
use std::io::ErrorKind;
use std::path::Path;

use crate::config::Config;
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

    Ok(())
}
