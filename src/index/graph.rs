use crate::{
    analysis::{
        self, Analysis,
        relationships::{Options, Relationships},
    },
    files::fingerprint,
    storage,
};
use crate::{
    files::cache::{load, persist},
    index::scan::Scan,
};
use anyhow::{Context, Result, ensure};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Serialize, Deserialize)]
pub(crate) struct Snapshot {
    version: u32,
    pub(crate) inputs: String,
    analyses: String,
    pub(crate) relationships: Relationships,
    #[serde(default)]
    pub(crate) source_hashes: std::collections::BTreeMap<String, String>,
}
#[derive(Debug)]
pub(crate) struct IncompleteCoverage(pub &'static str);
impl std::fmt::Display for IncompleteCoverage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for IncompleteCoverage {}

pub fn saved(db: &Connection, scan: &Scan) -> Result<Vec<Analysis>> {
    if scan
        .files
        .values()
        .any(|f| f.content == super::scan::Content::UnsupportedEncoding)
    {
        return Err(
            IncompleteCoverage("unsupported source encoding limits relationship coverage").into(),
        );
    }
    storage::validate_model(db)?;
    ensure!(scan.errors.is_empty(), "source/asset discovery incomplete");
    let indexed = super::update::indexed_paths(db)?;
    ensure!(
        indexed.len() == scan.files.len() && indexed.iter().all(|p| scan.files.contains_key(p)),
        "index does not cover the selected source paths"
    );
    let policy = storage::policy::read(db)?;
    let mut analyses = Vec::new();
    for path in indexed {
        let a = storage::analysis::load(db, &path)?.context("missing saved analysis")?;
        ensure!(
            scan.files[&path].error.is_none()
                && scan.files[&path].hash.as_deref()
                    == Some(fingerprint(a.source.text.as_bytes()).as_str()),
            "indexed source differs from working bytes: {path}"
        );
        storage::documents::load(
            db,
            &path,
            policy.as_deref().context("missing document policy")?,
        )?;
        // A syntax-diagnostic snapshot is navigable through ordinary index, but
        // cannot certify the complete watched dependency graph.
        if !a.diagnostics.is_empty() {
            return Err(
                IncompleteCoverage("parser diagnostics limit relationship coverage").into(),
            );
        }
        analyses.push(a);
    }
    Ok(analyses)
}
fn digest(analyses: &[Analysis]) -> Result<String> {
    Ok(fingerprint(&serde_json::to_vec(analyses)?))
}
pub fn publish(root: &Path, db: &Connection, scan: &Scan) -> Result<(bool, bool)> {
    let analyses = saved(db, scan)?;
    let inputs = scan.key();
    let analysis_digest = digest(&analyses)?;
    let source_hashes = analyses
        .iter()
        .map(|a| (a.source.path.clone(), fingerprint(a.source.text.as_bytes())))
        .collect();
    if let Some(value) = load(root, "relationships.json").ok().flatten()
        && let Ok(previous) = serde_json::from_value::<Snapshot>(value)
        && previous.version == 1
        && previous.inputs == inputs
        && previous.analyses == analysis_digest
        && previous.source_hashes == source_hashes
    {
        return Ok((false, false));
    }
    let snapshot = Snapshot {
        version: 1,
        inputs,
        analyses: analysis_digest,
        source_hashes,
        relationships: analysis::relationships::connect(
            &analyses,
            &Options {
                go_module_path: scan
                    .go_module
                    .as_deref()
                    .and_then(analysis::relationships::parse_go_module),
                project_paths: Some(scan.assets.iter().cloned().collect()),
            },
        ),
    };
    Ok((
        true,
        persist(root, "relationships.json", &serde_json::to_value(snapshot)?)?,
    ))
}
fn read_checked(root: &Path) -> Result<Relationships> {
    let root = root.canonicalize()?;
    let _lock = crate::storage::writer::acquire(&root)?;
    let snapshot: Snapshot = serde_json::from_value(
        load(&root, "relationships.json")?
            .context("indexed relationships unavailable; run mimirs watch --once")?,
    )?;
    ensure!(
        snapshot.version == 1,
        "unsupported indexed relationships version"
    );
    let (scan, _) = Scan::capture(&root, true, None)?;
    if scan.key() != snapshot.inputs {
        return Err(Stale("source/configuration/resolver inputs changed").into());
    }
    let mut db = storage::open_read_only(&root.join(".mimirs/index.db"))?;
    let tx = db.transaction()?;
    if digest(&saved(&tx, &scan)?)? != snapshot.analyses {
        return Err(Stale("saved analysis changed").into());
    }
    let (after, _) = Scan::capture(&root, true, None)?;
    ensure!(
        after.key() == scan.key(),
        "source changed during graph read; retry"
    );
    Ok(snapshot.relationships)
}

// Stable snapshot signature is also useful for local watch-state reports.
pub fn summary(root: &Path) -> serde_json::Value {
    match read(root) {
        Ok(r) => {
            serde_json::json!({"status":"current","imports":r.imports.len(),"calls":r.calls.len(),"re_exports":r.re_exports.len()})
        }
        Err(e) => serde_json::json!({"status":"unavailable","reason":format!("{e:#}")}),
    }
}

/// Cheap presence does not establish source freshness.
pub(crate) fn observation(root: &Path, previous: &serde_json::Value) -> serde_json::Value {
    let present = root.join(".mimirs/watch/relationships.json").is_file();
    let state = if present && previous["status"] == "verified_stale" {
        "verified_stale"
    } else if present {
        "unvalidated"
    } else if previous["status"] == "incomplete" {
        "incomplete"
    } else {
        "absent"
    };
    serde_json::json!({"status":state,"at":crate::status::now(),"basis":"presence only; no source scan or graph validation performed","assessment":previous})
}
pub fn read(root: &Path) -> Result<Relationships> {
    let result = read_checked(root);
    let state = match &result {
        Ok(_) => "assessed_current",
        Err(e) if e.downcast_ref::<Stale>().is_some() => "verified_stale",
        Err(_) if !root.join(".mimirs/watch/relationships.json").exists() => "absent",
        Err(_) => "incomplete",
    };
    crate::status::observation(
        root,
        "relationships-validation",
        "relationships",
        state,
        None,
        result.as_ref().err().map(|e| e.to_string()).as_deref(),
    );
    result
}

#[derive(Debug)]
struct Stale(&'static str);
impl std::fmt::Display for Stale {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "indexed relationships stale: {}; run mimirs index or watch --once",
            self.0
        )
    }
}
impl std::error::Error for Stale {}

/// Read one bounded saved view; source/resolver validation remains explicit.
pub(crate) fn navigation_snapshot(root: &Path) -> Result<(Snapshot, usize)> {
    use std::io::Read;
    let path = root.join(".mimirs/watch/relationships.json");
    let file = std::fs::File::open(path).context("saved relationship view is absent")?;
    const LIMIT: u64 = 16 * 1024 * 1024;
    ensure!(
        file.metadata()?.len() <= LIMIT,
        "saved relationship view exceeds navigation read limit"
    );
    let mut bytes = Vec::new();
    file.take(LIMIT + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() <= LIMIT as usize,
        "saved relationship view exceeds navigation read limit"
    );
    let snapshot: Snapshot = serde_json::from_slice(&bytes)?;
    ensure!(
        snapshot.version == 1 && !snapshot.source_hashes.is_empty(),
        "saved view lacks supported source bindings; run mimirs index"
    );
    Ok((snapshot, bytes.len()))
}
