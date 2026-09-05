use anyhow::{Result, ensure};
use rusqlite::{Connection, OptionalExtension, params};

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    #[default]
    Raw,
    Facts,
}

pub fn document_prefix() -> String {
    format!(
        "{}|{}|{}|{}|{}|",
        super::analysis::ANALYSIS_VERSION,
        crate::retrieval::PROJECTION_VERSION,
        crate::retrieval::render::RENDER_VERSION,
        crate::retrieval::split::TOKEN_POLICY,
        crate::embedding::MODEL_NAME
    )
}

pub fn document_policy(budget: &crate::retrieval::split::TokenBudget) -> String {
    format!(
        "{}{}|{}",
        document_prefix(),
        budget.limit,
        budget.fingerprint
    )
}

pub fn read(connection: &Connection) -> Result<(Mode, Option<String>)> {
    let read = |key| {
        connection
            .query_row(
                "SELECT value FROM index_metadata WHERE key=?1",
                [key],
                |r| r.get::<_, String>(0),
            )
            .optional()
    };
    let mode = read("retrieval_mode")?;
    let policy = read("document_policy")?;
    let documents: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM retrieval_processing)",
        [],
        |r| r.get(0),
    )?;
    match mode.as_deref() {
        None | Some("raw") => {
            ensure!(
                policy.is_none() && !documents,
                "raw index contains document policy/output"
            );
            Ok((Mode::Raw, None))
        }
        Some("facts") => {
            let value = policy
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("missing document policy"))?;
            ensure!(
                value.starts_with(&document_prefix()),
                "unsupported document policy; run mimirs index"
            );
            let mixed: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM retrieval_processing WHERE policy != ?1) OR EXISTS(SELECT 1 FROM retrieval_documents WHERE policy != ?1)", [value], |r| r.get(0))?;
            ensure!(!mixed, "mixed document policies");
            Ok((Mode::Facts, policy))
        }
        _ => anyhow::bail!("unsupported retrieval mode"),
    }
}

pub fn configure(connection: &mut Connection, mode: Mode, policy: Option<&str>) -> Result<()> {
    ensure!(
        (mode == Mode::Facts) == policy.is_some(),
        "mode/document policy mismatch"
    );
    let tx = connection.transaction()?;
    // Read the old strings without accepting them for retrieval. A policy version
    // update must still allow indexing to replace the obsolete output.
    let old_mode: Option<String> = tx
        .query_row(
            "SELECT value FROM index_metadata WHERE key='retrieval_mode'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    let old_policy: Option<String> = tx
        .query_row(
            "SELECT value FROM index_metadata WHERE key='document_policy'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    let name = if mode == Mode::Facts { "facts" } else { "raw" };
    if old_mode.as_deref().unwrap_or("raw") != name || old_policy.as_deref() != policy {
        tx.execute("DELETE FROM document_embeddings", [])?;
        tx.execute("DELETE FROM window_embeddings", [])?;
        tx.execute("DELETE FROM files", [])?;
    }
    tx.execute("INSERT INTO index_metadata VALUES ('retrieval_mode', ?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [name])?;
    tx.execute("DELETE FROM index_metadata WHERE key='document_policy'", [])?;
    if let Some(policy) = policy {
        tx.execute(
            "INSERT INTO index_metadata VALUES ('document_policy', ?1)",
            params![policy],
        )?;
    }
    tx.commit()?;
    Ok(())
}
