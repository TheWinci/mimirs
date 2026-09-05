use std::collections::HashSet;

use anyhow::Context;
use rusqlite::Connection;

/// Keep exactly the successfully indexed paths. vec0 needs explicit deletion;
/// foreign keys remove the relational children after their file is removed.
pub fn reconcile(connection: &mut Connection, successful: &[&str]) -> anyhow::Result<()> {
    let mut cleanup = || -> anyhow::Result<()> {
        let transaction = connection.transaction()?;
        super::validate_model(&transaction)?;
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
            super::delete_file_embeddings(&transaction, id)?;
            transaction.execute("DELETE FROM files WHERE id = ?1", [id])?;
        }
        transaction.commit()?;
        Ok(())
    };
    cleanup().context("cannot reconcile indexed files")
}
