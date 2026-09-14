//! Bounded local diagnostics. Never a source-validity or knowledge-truth authority.
mod activity;
mod view;
pub use activity::Activity;
pub(crate) use view::{read, utc};

use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const MAX_BYTES: usize = 128_000;
const HEARTBEAT_MS: u64 = 1_000;
const LIVE_AGE_MS: u64 = 5_000;
const COMPONENTS: [&str; 5] = [
    "source",
    "analysis",
    "vectors_model",
    "relationships",
    "knowledge",
];

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Target {
    pub repository: Option<String>,
    pub state: PathBuf,
    pub default_branch: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Event {
    id: String,
    operation: String,
    component: String,
    outcome: String,
    #[serde(default)]
    target: Option<Target>,
    started_at: u64,
    at: u64,
    file: Option<String>,
    claim: Option<String>,
    preview: Option<String>,
    reason: Option<String>,
    next: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Active {
    id: String,
    process_instance: String,
    pid: u32,
    operation: String,
    component: String,
    phase: String,
    file: Option<String>,
    #[serde(default)]
    target: Option<Target>,
    started_at: u64,
    heartbeat_at: u64,
    sequence: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Observation {
    status: String,
    at: u64,
    basis: String,
    next: String,
    #[serde(default)]
    target: Option<Target>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Snapshot {
    version: u32,
    mimirs: String,
    checkout: PathBuf,
    updated_at: u64,
    activities: BTreeMap<String, Active>,
    #[serde(default)]
    omitted_activities: usize,
    components: BTreeMap<String, Observation>,
    last_success: Option<Event>,
    last_failure: Option<Event>,
    last_indexed: Option<Event>,
    last_learned: Option<Event>,
    failures: Vec<Event>,
    recent: Vec<Event>,
    omitted_failures: usize,
    contract: String,
}
impl Snapshot {
    fn new(root: &Path) -> Self {
        Self { version: 2, mimirs: env!("CARGO_PKG_VERSION").into(), checkout: root.into(), updated_at: 0,
            activities: BTreeMap::new(), omitted_activities: 0, components: COMPONENTS.into_iter().map(|name| (name.into(), Observation {
                status: "unknown".into(), at: 0, basis: "no observation recorded; saved success never proves current freshness".into(),
                next: next(name).into(), target: None,
            })).collect(), last_success: None, last_failure: None, last_indexed: None, last_learned: None,
            failures: vec![], recent: vec![], omitted_failures: 0, contract:"Historical diagnostic snapshot. Later success does not resolve an earlier failure. Saved activity requires a held lease and a heartbeat no older than five seconds. No source freshness or claim truth is implied.".into() }
    }
    fn record(&mut self, event: Event) {
        if event.outcome == "success" {
            self.last_success = Some(event.clone());
            if event.operation == "learn" {
                self.last_learned = Some(event.clone());
            }
            if event.operation == "indexed" {
                self.last_indexed = Some(event.clone());
            }
        } else {
            self.last_failure = Some(event.clone());
            self.failures.push(event.clone());
            if self.failures.len() > 16 {
                self.failures.remove(0);
                self.omitted_failures += 1;
            }
        }
        self.recent.push(event);
        if self.recent.len() > 16 {
            self.recent.remove(0);
        }
    }
    fn observe(
        &mut self,
        component: &str,
        status: &str,
        basis: &str,
        at: u64,
        target: Option<Target>,
    ) {
        if COMPONENTS.contains(&component) {
            self.components.insert(
                component.into(),
                Observation {
                    status: status.into(),
                    at,
                    basis: bounded(basis, 384),
                    next: next(component).into(),
                    target,
                },
            );
        }
    }
}
pub(crate) fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}
pub(crate) fn bounded(value: &str, limit: usize) -> String {
    let mut output = String::new();
    // Status accepts short labels/previews, never multiline parser/source dumps.
    let value = value.lines().next().unwrap_or_default();
    static SECRETS: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let secrets = SECRETS.get_or_init(|| regex::Regex::new(
        r#"(?i)(?:https?://[^/\s:@]+:[^/\s@]+@|(?:bearer\s+|(?:password|passwd|token|api[_-]?key|secret|authorization)\s*[=:]\s*)[^\s,;]+|(?:sk-|ghp_|github_pat_)[a-z0-9_-]{8,})"#
    ).expect("constant credential pattern"));
    let value = secrets.replace_all(value, "[redacted]");
    for c in value.chars() {
        let text = if c.is_control() {
            " ".into()
        } else {
            c.to_string()
        };
        if output.len() + text.len() > limit {
            break;
        }
        output.push_str(&text);
    }
    output
}
fn next(component: &str) -> &'static str {
    match component {
        "knowledge" => {
            "Inspect knowledge settings/evidence with mimirs knowledge maintenance; see mimirs knowledge --help"
        }
        "vectors_model" => {
            "Vectors were not necessarily updated; inspect model availability, then retry mimirs index"
        }
        "relationships" => {
            "Run mimirs watch --once, or explicitly validate with mimirs status --validate"
        }
        _ => "Inspect the affected file or configuration, then retry mimirs index",
    }
}
fn path(root: &Path) -> PathBuf {
    root.join(".mimirs/status.json")
}
fn load(root: &Path) -> Result<Option<Snapshot>> {
    let canonical = root.canonicalize()?;
    let root = canonical.as_path();
    let path = match fs::symlink_metadata(path(root)) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => root.join(".mimirs/status"),
        _ => path(root),
    };
    let metadata = match fs::symlink_metadata(&path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e).context("cannot inspect status snapshot"),
    };
    ensure!(
        metadata.file_type().is_file() && metadata.len() <= MAX_BYTES as u64,
        "status must be a bounded regular file"
    );
    let mut bytes = Vec::new();
    fs::File::open(&path)?
        .take(MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= MAX_BYTES, "status exceeds its byte limit");
    let mut raw: serde_json::Value =
        serde_json::from_slice(&bytes).context("status snapshot is corrupt")?;
    if raw["version"] == 1 {
        // A disposable v1 snapshot carries useful history, not a recovery authority.
        raw["version"] = serde_json::json!(2);
        raw["failures"] = serde_json::json!(
            raw["failures"]
                .as_object()
                .context("invalid old status history")?
                .values()
                .map(|f| f["event"].clone())
                .collect::<Vec<_>>()
        );
        let activities = raw["activities"]
            .as_object()
            .context("invalid old status activities")?
            .values()
            .map(|a| (a["id"].as_str().unwrap_or_default().to_owned(), a.clone()))
            .collect::<serde_json::Map<_, _>>();
        raw["activities"] = serde_json::Value::Object(activities);
        for observation in raw["components"]
            .as_object_mut()
            .context("invalid old status components")?
            .values_mut()
        {
            observation["status"] = serde_json::json!("unknown");
            observation["basis"] = serde_json::json!(
                "imported historical observation; current health was not checked"
            );
        }
        raw["contract"] = serde_json::json!(Snapshot::new(root).contract);
    }
    let value: Snapshot = serde_json::from_value(raw).context("status snapshot is corrupt")?;
    ensure!(
        value.version == 2 && value.checkout == root,
        "status version or checkout does not match"
    );
    Ok(Some(value))
}
fn directory(root: &Path) -> Result<PathBuf> {
    let directory = root.join(".mimirs");
    fs::create_dir_all(&directory)?;
    ensure!(
        fs::symlink_metadata(&directory)?.file_type().is_dir(),
        "status directory must not be a symlink"
    );
    let ignore = directory.join(".gitignore");
    if !ignore.exists() {
        let mut file = tempfile::NamedTempFile::new_in(&directory)?;
        file.write_all(b"*\n")?;
        match file.persist_noclobber(&ignore) {
            Ok(_) => {}
            Err(e) if e.error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e.into()),
        }
    }
    // Respect customized ignore rules; diagnostics must not make evidence dirty.
    if fs::read_to_string(&ignore)?.trim() != "*" {
        let paths = [
            ".mimirs/status",
            ".mimirs/status.json",
            ".mimirs/status.json.tmp-probe",
            ".mimirs/status.lock",
            ".mimirs/status-owners/",
        ];
        let output = crate::git::command(root)?
            .arg("check-ignore")
            .args(paths)
            .output()?;
        if output.status.code() != Some(128) {
            ensure!(
                output.status.success()
                    && output
                        .stdout
                        .split(|b| *b == b'\n')
                        .filter(|line| !line.is_empty())
                        .count()
                        == paths.len(),
                "status paths are not ignored; add status, status.json, status.json.tmp-*, status.lock and status-owners/ to .mimirs/.gitignore"
            );
        }
    }
    Ok(directory)
}
fn update(root: &Path, edit: impl FnOnce(&mut Snapshot)) -> Result<()> {
    let directory = directory(root)?;
    let lock_path = directory.join("status.lock");
    if let Ok(m) = fs::symlink_metadata(&lock_path) {
        ensure!(
            m.file_type().is_file(),
            "status lock must be a regular file"
        );
    }
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(lock_path)?;
    let mut acquired = false;
    for _ in 0..40 {
        match lock.try_lock() {
            Ok(()) => {
                acquired = true;
                break;
            }
            Err(std::fs::TryLockError::WouldBlock) => std::thread::sleep(Duration::from_millis(5)),
            Err(e) => return Err(e.into()),
        }
    }
    ensure!(acquired, "status writer is busy; diagnostic update skipped");
    let result = (|| -> Result<()> {
        let mut snapshot = load(root)?.unwrap_or_else(|| Snapshot::new(root));
        if !path(root).try_exists()? {
            ensure!(
                snapshot
                    .activities
                    .values()
                    .all(|active| view::lease(root, active, now()).0 == "stopped"),
                "legacy status writer may still own activity; migration to status.json is deferred until it stops; cross-version activity cannot be combined"
            );
        }
        let before = serde_json::to_vec(&snapshot)?;
        edit(&mut snapshot);
        if serde_json::to_vec(&snapshot)? == before {
            return Ok(());
        }
        snapshot.updated_at = now();
        let bytes = serde_json::to_vec_pretty(&snapshot)?;
        ensure!(
            bytes.len() < MAX_BYTES,
            "status snapshot exceeds its bounded capacity"
        );
        let mut file = tempfile::Builder::new()
            .prefix("status.json.tmp-")
            .tempfile_in(&directory)?;
        file.write_all(&bytes)?;
        file.write_all(b"\n")?;
        // Atomic visibility is required; this disposable snapshot is not a durable journal.
        file.persist(path(root))?;
        Ok(())
    })();
    let _ = lock.unlock();
    result
}
fn warn(result: Result<()>) {
    if let Err(error) = result {
        eprintln!(
            "status diagnostic: {}; operation outcome is unchanged. See .mimirs/status.json or mimirs status",
            bounded(&error.to_string(), 384)
        );
    }
}

/// Record a supplied observation. Repeated identical observations coalesce; history never changes health.
pub fn observation(
    root: &Path,
    operation: &str,
    component: &str,
    status: &str,
    target: Option<Target>,
    error: Option<&str>,
) {
    let Ok(root) = root.canonicalize() else {
        return;
    };
    let basis = error.map(|e| bounded(e, 384)).unwrap_or_else(|| {
        "operation observed at this time; no continuing freshness guarantee".into()
    });
    warn(update(&root, |snapshot| {
        if snapshot
            .components
            .get(component)
            .is_some_and(|old| old.status == status && old.target == target && old.basis == basis)
        {
            return;
        }
        if status != "disabled" && status != "unknown" {
            snapshot.record(Event {
                id: uuid::Uuid::now_v7().to_string(),
                operation: operation.into(),
                component: component.into(),
                outcome: if error.is_some() {
                    "failure"
                } else {
                    "success"
                }
                .into(),
                target: target.clone(),
                started_at: now(),
                at: now(),
                file: None,
                claim: None,
                preview: None,
                reason: error.map(|e| bounded(e, 384)),
                next: error.map(|_| next(component).into()),
            });
        }
        snapshot.observe(component, status, &basis, now(), target);
    }));
}

#[cfg(test)]
#[path = "../tests/unit/status.rs"]
mod tests;
