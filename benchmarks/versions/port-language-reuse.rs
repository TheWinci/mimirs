//! Reuse accepted vectors only after proving every analysis record and document
//! is unchanged. Run on a disposable SQLite backup, never the reference index.
use anyhow::{Result, ensure};
use sha2::{Digest, Sha256};

#[test]
#[ignore = "requires a disposable MIMIRS_PORT_REUSE_COPY, MIMIRS_PORT_POLICY_FILE and MIMIRS_PORT_REUSE_REPORT"]
fn verify_language_index_copy_before_reusing_vectors() -> Result<()> {
    let target = std::env::var("MIMIRS_PORT_REUSE_COPY")?;
    let report = std::env::var("MIMIRS_PORT_REUSE_REPORT")?;
    ensure!(
        !std::path::Path::new(&report).exists(),
        "report already exists"
    );
    let policy = std::fs::read_to_string(std::env::var("MIMIRS_PORT_POLICY_FILE")?)?;
    let mut db = crate::storage::open(std::path::Path::new(&target))?.connection;
    let old: String = db.query_row(
        "SELECT value FROM index_metadata WHERE key='document_policy'",
        [],
        |r| r.get(0),
    )?;
    ensure!(
        old.split_once('|').map(|p| p.1) == policy.split_once('|').map(|p| p.1),
        "embedding or retrieval policy changed"
    );
    crate::storage::policy::validate(&policy)?;
    let vectors = |db: &rusqlite::Connection| -> Result<(usize, String)> {
        let mut query = db.prepare(
            "SELECT document_id, embedding FROM document_embeddings ORDER BY document_id",
        )?;
        let rows = query.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?)))?;
        let mut hash = Sha256::new();
        let mut count = 0;
        for row in rows {
            let (id, bytes) = row?;
            hash.update(id.to_le_bytes());
            hash.update(bytes);
            count += 1;
        }
        Ok((
            count,
            hash.finalize()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>(),
        ))
    };
    let before = vectors(&db)?;
    let tx = db.transaction()?;
    let sources = tx.prepare("SELECT f.id, f.path, s.source FROM files f JOIN source_snapshots s ON s.file_id=f.id ORDER BY f.path")?
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    tx.execute(
        "UPDATE index_metadata SET value=?1 WHERE key='document_policy'",
        [&policy],
    )?;
    tx.execute("UPDATE retrieval_processing SET policy=?1", [&policy])?;
    tx.execute("UPDATE retrieval_documents SET policy=?1", [&policy])?;
    let mut document_count = 0;
    for (id, path, text) in &sources {
        let actual = crate::analysis::extract(crate::source::SourceFile {
            path: path.clone(),
            text: text.clone(),
        })?;
        tx.execute(
            "UPDATE source_snapshots SET analysis_version=?1 WHERE file_id=?2",
            rusqlite::params![crate::analysis::language::for_path(path).identity, id],
        )?;
        let stored = crate::storage::analysis::load(&tx, path)?.expect("copied snapshot");
        ensure!(actual == stored, "analysis changed for {path}");
        let actual = crate::retrieval::ts_v2::documents(&actual)?;
        let stored = crate::storage::documents::load(&tx, path, &policy)?;
        ensure!(
            actual == stored,
            "embedding inputs or evidence changed for {path}"
        );
        document_count += actual.len();
    }
    ensure!(
        crate::storage::policy::read(&tx)?.as_deref() == Some(policy.as_str()),
        "invalid copied index"
    );
    ensure!(before.0 == document_count, "missing accepted vectors");
    let after = vectors(&tx)?;
    ensure!(before == after, "vectors changed");
    tx.commit()?;
    let output = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(report)?;
    serde_json::to_writer_pretty(
        output,
        &serde_json::json!({
            "files": sources.len(), "documents": document_count, "analysisMismatches": 0,
            "documentMismatches": 0, "inferenceCalls": 0, "vectorBytesChanged": false,
            "vectorSha256": before.1,
        }),
    )?;
    Ok(())
}
