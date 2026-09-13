use std::fs;
use std::io::ErrorKind;
use std::path::Path;

use crate::{config::Config, embedding, storage};

/// Written to `.mimirs/.gitignore`, so the directory ignores itself.
const IGNORE_CONTENTS: &str = "*\n";

pub fn run() -> anyhow::Result<()> {
    run_at(Path::new("."), || embedding::production()?.prepare())
}

fn run_at(
    project_root: &Path,
    prepare_model: impl FnOnce() -> anyhow::Result<()>,
) -> anyhow::Result<()> {
    let mut activity = crate::status::Activity::start(project_root, "init", "source");
    completion(&mut activity, false);
    let result = initialize(project_root, prepare_model, &mut activity);
    completion(&mut activity, result.is_ok());
    activity.result(&result);
    result
}
fn initialize(
    project_root: &Path,
    prepare_model: impl FnOnce() -> anyhow::Result<()>,
    activity: &mut crate::status::Activity,
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

    let writer = storage::writer::acquire(project_root)?;
    let database_path = root.join("index.db");
    let database = storage::open(&database_path)?;
    println!("{}", database.outcome.message(&database_path));
    drop(database.connection);
    drop(writer);

    eprintln!("preparing embedding model: {}", embedding::MODEL_NAME);
    activity.progress("preparing model", "vectors_model", None);
    prepare_model()?;
    println!("embedding model ready: {}", embedding::MODEL_NAME);
    println!(
        "Next: run mimirs index, then mimirs context \"your task\". Use --knowledge off for source-only context."
    );

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

fn completion(activity: &mut crate::status::Activity, successful: bool) {
    activity.completion(&[
        (
            "source",
            "incomplete",
            "initialization does not index source",
        ),
        (
            "analysis",
            "incomplete",
            "initialization does not extract project analysis",
        ),
        (
            "vectors_model",
            if successful {
                "incomplete"
            } else {
                "unavailable"
            },
            "initialization prepares a model; project vectors still require indexing",
        ),
    ]);
}
