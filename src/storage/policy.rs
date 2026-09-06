use anyhow::{Result, ensure};
use rusqlite::Connection;

fn document_prefix_for(source_policy: &str) -> String {
    format!(
        "{}|{}|{}|",
        crate::analysis::language::registry_identity(),
        source_policy,
        crate::embedding::model_identity()
    )
}

pub fn document_policy(budget: &crate::retrieval::split::TokenBudget) -> String {
    format!(
        "{}{}|{}",
        document_prefix_for(crate::retrieval::source::POLICY),
        budget.limit,
        budget.fingerprint
    )
}

pub(super) fn validate(policy: &str) -> Result<()> {
    ensure!(
        policy.starts_with(&document_prefix_for(crate::retrieval::source::POLICY))
            || policy.starts_with(&document_prefix_for(crate::retrieval::ts_v2::POLICY)),
        "unsupported document policy; run mimirs index"
    );
    Ok(())
}

pub fn read(connection: &Connection) -> Result<Option<String>> {
    let policy = super::metadata(connection, "document_policy")?;
    let populated: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM files) OR EXISTS(SELECT 1 FROM document_embeddings)",
        [],
        |r| r.get(0),
    )?;
    let Some(value) = policy else {
        ensure!(!populated, "missing document policy; run mimirs index");
        return Ok(None);
    };
    validate(&value)?;
    let mixed: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM retrieval_processing WHERE policy != ?1) OR EXISTS(SELECT 1 FROM retrieval_documents WHERE policy != ?1)", [&value], |r| r.get(0))?;
    ensure!(!mixed, "mixed document policies; run mimirs index");
    let incomplete: bool = connection.query_row("SELECT
        EXISTS(SELECT 1 FROM files f LEFT JOIN source_snapshots s ON s.file_id=f.id WHERE s.file_id IS NULL)
        OR EXISTS(SELECT 1 FROM source_snapshots s LEFT JOIN retrieval_processing p ON p.file_id=s.file_id WHERE p.file_id IS NULL)
        OR EXISTS(SELECT 1 FROM retrieval_processing p WHERE
            p.document_count != (SELECT count(*) FROM retrieval_documents d WHERE d.file_id=p.file_id)
            OR p.document_count != (SELECT count(*) FROM document_embeddings e JOIN retrieval_documents d ON d.id=e.document_id WHERE d.file_id=p.file_id))
        OR EXISTS(SELECT 1 FROM document_embeddings e LEFT JOIN retrieval_documents d ON d.id=e.document_id WHERE d.id IS NULL)
        OR EXISTS(SELECT 1 FROM retrieval_documents d LEFT JOIN document_fts l ON l.rowid=d.id WHERE l.rowid IS NULL)
        OR EXISTS(SELECT 1 FROM document_fts l LEFT JOIN retrieval_documents d ON d.id=l.rowid WHERE d.id IS NULL)", [], |r| r.get(0))?;
    ensure!(
        !incomplete,
        "incomplete source retrieval output; run mimirs index"
    );
    Ok(Some(value))
}

pub fn configure(connection: &mut Connection, policy: &str) -> Result<()> {
    validate(policy)?;
    let tx = connection.transaction()?;
    if super::metadata(&tx, "document_policy")?.as_deref() != Some(policy) {
        tx.execute("DELETE FROM document_embeddings", [])?;
        tx.execute("DELETE FROM files", [])?;
    }
    tx.execute("INSERT INTO index_metadata VALUES ('document_policy', ?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [policy])?;
    tx.commit()?;
    Ok(())
}

#[allow(dead_code)]
pub fn ts_document_policy(budget: &crate::retrieval::split::TokenBudget) -> String {
    format!(
        "{}256|{}",
        document_prefix_for(crate::retrieval::ts_v2::POLICY),
        budget.fingerprint
    )
}
