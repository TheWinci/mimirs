use std::collections::HashSet;

use anyhow::Context;
use rusqlite::Connection;

/// Keep exactly the successfully indexed paths. vec0 needs explicit deletion;
/// foreign keys remove the relational children after their file is removed.
pub fn reconcile(
    connection: &mut Connection,
    successful: &[&str],
    model: &str,
    dimension: usize,
) -> anyhow::Result<()> {
    let mut cleanup = || -> anyhow::Result<()> {
        let transaction = connection.transaction()?;
        super::validate_model(&transaction, model, dimension)?;
        let keep: HashSet<&str> = successful.iter().copied().collect();
        let stale = {
            let mut statement = transaction.prepare("SELECT id, path FROM files")?;
            let rows = statement.query_map([], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })?;
            let mut stale = Vec::new();
            for row in rows {
                let (id, path) = row?;
                if !keep.contains(path.as_str()) {
                    stale.push(id);
                }
            }
            stale
        };
        for id in stale {
            transaction.execute(
                "DELETE FROM window_embeddings WHERE window_id IN (
                    SELECT w.id FROM windows w JOIN chunks c ON c.id = w.chunk_id WHERE c.file_id = ?1
                )", [id],
            )?;
            transaction.execute("DELETE FROM files WHERE id = ?1", [id])?;
        }
        transaction.commit()?;
        Ok(())
    };
    cleanup().context("cannot reconcile indexed files")
}
