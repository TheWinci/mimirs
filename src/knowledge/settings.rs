//! Explicit checkout-local defaults, independent of source indexing and model setup.
use super::model::RepositoryId;
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Default, Deserialize, Serialize)]
pub struct Settings {
    pub version: Option<u32>,
    pub repository: Option<String>,
    pub default_branch: Option<String>,
    pub registry: Option<PathBuf>,
}
pub struct Resolved {
    pub repository: Option<RepositoryId>,
    pub default_branch: String,
    pub registry: Option<PathBuf>,
}
pub fn path(root: &Path) -> PathBuf {
    root.join(".mimirs/knowledge/settings.toml")
}
fn read(root: &Path) -> Result<Option<String>> {
    match fs::read_to_string(path(root)) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e).with_context(|| format!("cannot read {}", path(root).display())),
    }
}
fn parse(text: &str) -> Result<Settings> {
    let value: Settings = toml::from_str(text)?;
    ensure!(
        value.version == Some(1),
        "unsupported or missing settings version; expected version = 1"
    );
    Ok(value)
}
fn branch(value: &str) -> Result<()> {
    ensure!(
        !value.trim().is_empty()
            && crate::git::command(&std::env::current_dir()?)?
                .args(["check-ref-format", &format!("refs/heads/{value}")])
                .output()?
                .status
                .success(),
        "invalid default branch"
    );
    Ok(())
}
pub fn diagnostic_target(
    root: &Path,
    state: Option<&Path>,
    repository: Option<&RepositoryId>,
    default_branch: Option<&str>,
) -> crate::status::Target {
    crate::status::Target {
        repository: repository.map(|r| r.0.clone()),
        state: std::path::absolute(state.unwrap_or(&root.join(".mimirs/knowledge")))
            .unwrap_or_else(|_| root.join(".mimirs/knowledge")),
        default_branch: default_branch.map(str::to_owned),
    }
}

pub fn resolve(
    root: &Path,
    repository: Option<&str>,
    default_branch: Option<&str>,
    registry: Option<&Path>,
) -> Result<Resolved> {
    let saved = read(root)?
        .map(|s| parse(&s))
        .transpose()
        .with_context(|| {
            format!(
                "repair {} or restore a valid version 1 settings file",
                path(root).display()
            )
        })?
        .unwrap_or_default();
    let repository = repository
        .map(str::to_owned)
        .or(saved.repository)
        .map(RepositoryId);
    if let Some(id) = &repository {
        id.validate()?;
    }
    let default_branch = default_branch
        .map(str::to_owned)
        .or(saved.default_branch)
        .unwrap_or_else(|| "main".into());
    branch(&default_branch)?;
    let registry = registry.map(Path::to_path_buf).or(saved.registry);
    ensure!(
        registry.as_ref().is_none_or(|p| !p.as_os_str().is_empty()),
        "registry path must not be empty"
    );
    let registry = registry.map(|p| if p.is_absolute() { p } else { root.join(p) });
    Ok(Resolved {
        repository,
        default_branch,
        registry,
    })
}

/// Replace only supplied scalar values. Spans preserve comments and unknown settings.
pub fn setup(
    root: &Path,
    repository: Option<&str>,
    default_branch: Option<&str>,
    registry: Option<&Path>,
) -> Result<serde_json::Value> {
    let root = root.canonicalize()?;
    let path = path(&root);
    let parent = path.parent().unwrap();
    fs::create_dir_all(parent)?;
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(parent.join("settings.lock"))?;
    lock.lock()?;
    let before = read(&root)?.unwrap_or_default();
    let resolved = resolve(&root, repository, default_branch, registry)?;
    let id = resolved
        .repository
        .context("supply --repository with a stable logical identity for setup")?;
    let mut updates = BTreeMap::from([
        ("version", toml::Value::Integer(1)),
        ("repository", toml::Value::String(id.0.clone())),
        (
            "default_branch",
            toml::Value::String(resolved.default_branch.clone()),
        ),
    ]);
    if let Some(value) = registry {
        ensure!(
            !value.as_os_str().is_empty(),
            "registry path must not be empty"
        );
        updates.insert(
            "registry",
            toml::Value::String(
                value
                    .to_str()
                    .context("registry path must be UTF-8")?
                    .into(),
            ),
        );
    }
    let existing: BTreeMap<String, toml::Spanned<toml::Value>> = toml::from_str(&before)?;
    let mut edits = Vec::new();
    let mut prefix = String::new();
    for (key, value) in updates {
        if let Some(old) = existing.get(key) {
            if old.get_ref() != &value {
                edits.push((old.span(), value.to_string()));
            }
        } else {
            prefix.push_str(&format!("{key} = {value}\n"));
        }
    }
    let mut after = before.clone();
    edits.sort_by_key(|(span, _)| std::cmp::Reverse(span.start));
    for (span, value) in edits {
        after.replace_range(span, &value);
    }
    after.insert_str(0, &prefix);
    parse(&after)?;
    let changed = after != before;
    if changed {
        let mut file = tempfile::NamedTempFile::new_in(parent)?;
        file.write_all(after.as_bytes())?;
        file.as_file().sync_all()?;
        if path.exists() {
            file.as_file()
                .set_permissions(fs::metadata(&path)?.permissions())?;
        }
        file.persist(&path)?;
        fs::File::open(parent)?.sync_all()?;
    }
    // Local identity and journal state must not be swept into a source commit.
    // Existing ignore policy belongs to the user and remains byte-for-byte intact.
    let ignore = parent.join(".gitignore");
    if !ignore.try_exists()? {
        let mut file = tempfile::NamedTempFile::new_in(parent)?;
        file.write_all(b"*\n")?;
        file.as_file().sync_all()?;
        match file.persist_noclobber(ignore) {
            Ok(_) => {}
            Err(e) if e.error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e.into()),
        }
    }
    fs::create_dir_all(
        root.join(".mimirs/knowledge/repositories")
            .join(super::fingerprint(id.0.as_bytes())),
    )?;
    Ok(
        serde_json::json!({"settings":path,"changed":changed,"repository":id,"default_branch":resolved.default_branch,
        "registry":resolve(&root,None,None,None)?.registry,"next":"Use mimirs context for task work. Learning and maintenance remain explicit."}),
    )
}
