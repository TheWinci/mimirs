use std::fs;
use std::io::ErrorKind;
use std::path::Path;

/// Contents written to `.mimirs/.gitignore`, making the directory ignore itself.
const IGNORE_CONTENTS: &str = "*\n";

pub fn run(no_gitignore: bool) -> anyhow::Result<()> {
    let root = Path::new(".mimirs");
    let ignore_path = root.join(".gitignore");

    let created_dir = match std::fs::create_dir(root) {
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

    if !no_gitignore {
        match fs::read_to_string(&ignore_path) {
            Ok(content) if content == IGNORE_CONTENTS => {
                println!("{} already up to date", ignore_path.display())
            }
            Ok(_) => println!(
                "{} differs from the default, left unchanged",
                ignore_path.display()
            ),
            Err(e) if e.kind() == ErrorKind::NotFound => {
                fs::write(&ignore_path, IGNORE_CONTENTS)?;
                let verb = if created_dir { "created" } else { "recreated" };
                println!("{verb} {}", ignore_path.display());
            }
            Err(e) => return Err(e.into()),
        }
    }

    Ok(())
}
