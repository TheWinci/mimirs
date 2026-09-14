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
pub(crate) fn common_identity_path(root: &Path) -> Result<Option<PathBuf>> {
    let output = crate::git::command(root)?
        .args(["rev-parse", "--path-format=absolute", "--git-common-dir"])
        .output()?;
    if !output.status.success() {
        return Ok(None);
    }
    let directory = std::str::from_utf8(&output.stdout)?.trim_end_matches('\n');
    ensure!(!directory.is_empty(), "Git common directory is missing");
    Ok(Some(
        PathBuf::from(directory).join("mimirs-local-identity.json"),
    ))
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct LocalIdentity {
    version: u32,
    repository: String,
}
fn local_identity(root: &Path, create: bool) -> Result<Option<RepositoryId>> {
    let Some(path) = common_identity_path(root)? else {
        ensure!(
            !create,
            "local knowledge setup requires a Git repository; supply --repository for an explicit identity"
        );
        return Ok(None);
    };
    let read = || -> Result<Option<RepositoryId>> {
        let metadata = match fs::symlink_metadata(&path) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        ensure!(
            metadata.file_type().is_file() && metadata.len() <= 4096,
            "local identity must be a small regular file"
        );
        let value: LocalIdentity = serde_json::from_slice(&fs::read(&path)?)?;
        ensure!(value.version == 1, "unsupported local identity version");
        uuid::Uuid::parse_str(
            value
                .repository
                .strip_prefix("local/")
                .context("invalid local identity")?,
        )?;
        let id = RepositoryId(value.repository);
        id.validate()?;
        Ok(Some(id))
    };
    let checked = || {
        read().with_context(|| format!("repair {} or restore its original identity from backup; do not replace it with another repository identity", path.display()))
    };
    if let Some(id) = checked()? {
        return Ok(Some(id));
    }
    if !create {
        return Ok(None);
    }
    let parent = path.parent().context("missing Git common directory")?;
    let value = LocalIdentity {
        version: 1,
        repository: format!("local/{}", uuid::Uuid::now_v7()),
    };
    let mut file = tempfile::NamedTempFile::new_in(parent)?;
    serde_json::to_writer(&mut file, &value)?;
    file.as_file().sync_all()?;
    match file.persist_noclobber(&path) {
        Ok(_) => {
            fs::File::open(parent)?.sync_all()?;
        }
        Err(e) if e.error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e.into()),
    }
    checked()
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
    let repository = match repository {
        Some(id) => Some(id),
        None => local_identity(root, false)?,
    };
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
    let id = match resolved.repository {
        Some(id) => id,
        None => local_identity(&root, true)?.context("local identity was not persisted")?,
    };
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

/// Resolve the target and cheap presence only. A status read never replays a journal.
pub(crate) fn observation(root: &Path, previous: &serde_json::Value) -> serde_json::Value {
    let result = (|| -> Result<serde_json::Value> {
        let resolved = resolve(root, None, None, None)?;
        let target = diagnostic_target(
            root,
            None,
            resolved.repository.as_ref(),
            Some(&resolved.default_branch),
        );
        let Some(repository) = resolved.repository else {
            return Ok(
                serde_json::json!({"status":"unconfigured","target":target,"basis":"no knowledge identity configured"}),
            );
        };
        let directory = target
            .state
            .join("repositories")
            .join(super::fingerprint(repository.0.as_bytes()));
        let same = previous["target"] == serde_json::to_value(&target)?;
        let state = if same && directory.is_dir() {
            match previous["status"].as_str() {
                Some("configured_empty") => "configured_empty",
                Some("assessed") => "assessed",
                Some("unavailable") => "unavailable",
                _ => "not_yet_assessed",
            }
        } else {
            "not_yet_assessed"
        };
        Ok(
            serde_json::json!({"status":state,"target":target,"journal_directory_present":directory.is_dir(),
            "basis":"configuration and presence only; saved assessments describe their recorded time",
            "assessment":if same { previous.clone() } else { serde_json::Value::Null }}),
        )
    })();
    result.unwrap_or_else(|e| serde_json::json!({"status":"unavailable","reason":format!("{e:#}"),"basis":"configuration could not be resolved"}))
}
