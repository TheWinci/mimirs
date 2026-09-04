use std::fs;
use std::io::ErrorKind;
use std::path::Path;

use crate::{config::Config, embedding, storage};

/// Written to `.mimirs/.gitignore`, so the directory ignores itself.
const IGNORE_CONTENTS: &str = "*\n";

pub fn run() -> anyhow::Result<()> {
    run_at(Path::new("."))
}

fn run_at(project_root: &Path) -> anyhow::Result<()> {
    run_at_with_model(project_root, embedding::prepare_model)
}

fn run_at_with_model(
    project_root: &Path,
    mut prepare_model: impl FnMut() -> anyhow::Result<()>,
) -> anyhow::Result<()> {
    let root = project_root.join(".mimirs");

    let created_dir = match fs::create_dir(&root) {
        Ok(()) => {
            println!("{} created", root.display());
            true
        }
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {
            println!("{} already exists", root.display());
            false
        }
        Err(error) => return Err(error.into()),
    };

    write_default(&root.join(".gitignore"), IGNORE_CONTENTS, created_dir)?;

    write_default(
        &root.join("config.toml"),
        &Config::default().to_toml()?,
        created_dir,
    )?;

    let database_path = root.join("index.db");
    let database = storage::open(&database_path)?;
    println!("{}", database.outcome.message(&database_path));
    drop(database.connection);

    eprintln!("preparing embedding model: {}", embedding::MODEL_NAME);
    prepare_model()?;
    println!("embedding model ready: {}", embedding::MODEL_NAME);

    Ok(())
}

/// Write `contents` only when `path` is absent, so an edit by the user stays.
fn write_default(path: &Path, contents: &str, created_dir: bool) -> anyhow::Result<()> {
    match fs::read_to_string(path) {
        Ok(existing) if existing == contents => println!("{} already up to date", path.display()),
        Ok(_) => println!(
            "{} differs from the default, left unchanged",
            path.display()
        ),
        Err(e) if e.kind() == ErrorKind::NotFound => {
            fs::write(path, contents)?;
            let verb = if created_dir { "created" } else { "recreated" };
            println!("{verb} {}", path.display());
        }
        Err(e) => return Err(e.into()),
    }

    Ok(())
}

#[cfg(test)]
#[path = "../../tests/unit/commands/init.rs"]
mod tests;
