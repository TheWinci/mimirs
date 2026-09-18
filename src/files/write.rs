use std::fs;
use std::io::ErrorKind;
use std::path::Path;

/// Write `contents` to `path` when the file is absent, and report what happened.
/// Leave a file that the user changed unchanged.
pub fn write_default(path: &Path, contents: &str, created_dir: bool) -> anyhow::Result<()> {
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