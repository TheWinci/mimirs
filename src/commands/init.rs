use std::fs;
use std::io::ErrorKind;
use std::path::Path;

use crate::config::Config;

/// Contents written to `.mimirs/.gitignore`, making the directory ignore itself.
const IGNORE_CONTENTS: &str = "*\n";

pub fn run() -> anyhow::Result<()> {
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

/// Write `contents` to `path` when the file is absent, and report what happened.
/// Leave a file that the user changed unchanged.
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
