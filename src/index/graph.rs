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
struct Snapshot {
    version: u32,
    inputs: String,
    analyses: String,
    relationships: Relationships,
}
pub fn saved(db: &Connection, scan: &Scan) -> Result<Vec<Analysis>> {
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
        ensure!(
            a.diagnostics.is_empty(),
            "syntax diagnostics prevent a complete graph: {path}"
        );
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
    if let Some(value) = load(root, "relationships.json").ok().flatten()
        && let Ok(previous) = serde_json::from_value::<Snapshot>(value)
        && previous.version == 1
        && previous.inputs == inputs
        && previous.analyses == analysis_digest
    {
        return Ok((false, false));
    }
    let snapshot = Snapshot {
        version: 1,
        inputs,
        analyses: analysis_digest,
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
pub fn read(root: &Path) -> Result<Relationships> {
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
    ensure!(
        scan.key() == snapshot.inputs,
        "indexed relationships stale: source/configuration/resolver inputs changed; run watch --once or use live relationships"
    );
    let mut db = storage::open_read_only(&root.join(".mimirs/index.db"))?;
    let tx = db.transaction()?;
    ensure!(
        digest(&saved(&tx, &scan)?)? == snapshot.analyses,
        "indexed relationships stale: saved analysis changed"
    );
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
