//! Durable intermediate snapshots live outside the searchable index schema.
use crate::{
    analysis::Analysis,
    embedding::{DIMENSION, WindowPlan},
    profiling::Profiler,
    retrieval::split::Document,
};
use anyhow::{Context, Result, ensure};
use rusqlite::{Connection, params};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

pub(crate) struct Key<'a> {
    pub ordinal: usize,
    pub path: &'a str,
    pub source_hash: &'a str,
    pub policy: &'a str,
}

pub(crate) enum Stage<'a> {
    Discovered,
    Source(&'a Analysis),
    Windows(&'a [Document], &'a WindowPlan),
    Vectors(&'a [Vec<f32>]),
}

impl Stage<'_> {
    fn encode(&self, key: &Key<'_>) -> Result<(&'static str, usize, Vec<u8>)> {
        Ok(match self {
            Self::Discovered => ("work", 1, Vec::new()),
            Self::Source(analysis) => {
                ensure!(
                    analysis.source.path == key.path
                        && super::processing::source_hash(&analysis.source.text) == key.source_hash,
                    "stale staged source"
                );
                super::analysis::validate(analysis)?;
                (
                    "source_stages",
                    analysis.source_chunks.len(),
                    serde_json::to_vec(analysis)?,
                )
            }
            Self::Windows(documents, plan) => {
                plan.validate(documents.len(), key.path)?;
                (
                    "window_stages",
                    documents.len(),
                    serde_json::to_vec(&(
                        documents,
                        plan.inputs.as_ref(),
                        plan.documents.as_ref(),
                    ))?,
                )
            }
            Self::Vectors(vectors) => {
                ensure!(
                    vectors
                        .iter()
                        .all(|v| v.len() == DIMENSION && v.iter().all(|x| x.is_finite())),
                    "invalid staged vectors"
                );
                (
                    "vector_stages",
                    vectors.len(),
                    vectors
                        .iter()
                        .flat_map(|v| v.iter().flat_map(|x| x.to_le_bytes()))
                        .collect(),
                )
            }
        })
    }
}

pub(crate) struct Store {
    connection: Connection,
    run: String,
    path: PathBuf,
    profile: Profiler,
}

impl Store {
    /// Caller holds the index's OS writer lock, including during cleanup.
    pub fn open(path: &Path, profile: &Profiler) -> Result<Self> {
        let mut connection = Connection::open(path)?;
        connection.execute_batch(
            "PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;",
        )?;
        let version: i64 = connection.pragma_query_value(None, "user_version", |r| r.get(0))?;
        ensure!(version <= 1, "unsupported staging schema {version}");
        connection.execute_batch("CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS work(run TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, ordinal INTEGER NOT NULL, path TEXT NOT NULL, source_hash TEXT NOT NULL, policy TEXT NOT NULL, discovered INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(run, ordinal), UNIQUE(run,path), UNIQUE(run,ordinal,source_hash,policy));")?;
        for table in ["source_stages", "window_stages", "vector_stages"] {
            connection.execute_batch(&format!("CREATE TABLE IF NOT EXISTS {table}(run TEXT NOT NULL, ordinal INTEGER NOT NULL, source_hash TEXT NOT NULL, policy TEXT NOT NULL, items INTEGER NOT NULL, digest BLOB NOT NULL, payload BLOB NOT NULL, PRIMARY KEY(run,ordinal), FOREIGN KEY(run,ordinal,source_hash,policy) REFERENCES work(run,ordinal,source_hash,policy) ON DELETE CASCADE);"))?;
        }
        connection.pragma_update(None, "user_version", 1)?;
        let abandoned: i64 = connection.query_row("SELECT count(*) FROM work", [], |r| r.get(0))?;
        profile.count("staging_abandoned_files", abandoned as usize);
        let run = format!(
            "{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)?
                .as_nanos()
        );
        let tx = connection.transaction()?;
        tx.execute("DELETE FROM runs", [])?;
        tx.execute("INSERT INTO runs VALUES (?1)", [&run])?;
        tx.commit()?;
        Ok(Self {
            connection,
            run,
            path: path.to_owned(),
            profile: profile.clone(),
        })
    }

    pub fn record(&mut self, key: &Key<'_>, stage: Stage<'_>) -> Result<()> {
        let _work = self.profile.scope("staging_save");
        super::policy::validate(key.policy)?;
        ensure!(
            key.source_hash.len() == 64 && key.source_hash.bytes().all(|b| b.is_ascii_hexdigit()),
            "invalid staging source hash"
        );
        let (table, count, payload) = stage.encode(key)?;
        let digest = Sha256::digest(&payload).to_vec();
        let tx = self.connection.transaction()?;
        tx.execute("INSERT INTO work(run,ordinal,path,source_hash,policy) VALUES (?1,?2,?3,?4,?5) ON CONFLICT(run,ordinal) DO NOTHING", params![self.run,key.ordinal as i64,key.path,key.source_hash,key.policy])?;
        let identity: (String, String, String) = tx.query_row(
            "SELECT path,source_hash,policy FROM work WHERE run=?1 AND ordinal=?2",
            params![self.run, key.ordinal as i64],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        ensure!(
            identity == (key.path.into(), key.source_hash.into(), key.policy.into()),
            "stale staging identity"
        );
        if table == "work" {
            tx.execute(
                "UPDATE work SET discovered=1 WHERE run=?1 AND ordinal=?2",
                params![self.run, key.ordinal as i64],
            )?;
        } else {
            tx.execute(&format!("INSERT INTO {table} VALUES (?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(run,ordinal) DO NOTHING"), params![self.run,key.ordinal as i64,key.source_hash,key.policy,count as i64,digest,payload])?;
            let saved: (i64, Vec<u8>) = tx.query_row(
                &format!("SELECT items,digest FROM {table} WHERE run=?1 AND ordinal=?2"),
                params![self.run, key.ordinal as i64],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            ensure!(saved == (count as i64, digest), "conflicting staged result");
        }
        let journal = self.path.with_file_name("staging.db-journal");
        let disk = std::fs::metadata(&self.path)?.len()
            + std::fs::metadata(journal).map_or(0, |m| m.len());
        self.profile
            .maximum("staging_peak_disk_bytes", disk as usize);
        tx.commit()?;
        self.profile.count("staging_transactions", 1);
        self.profile.count("staging_bytes_written", payload.len());
        self.profile.maximum(
            "staging_peak_disk_bytes",
            std::fs::metadata(&self.path)?.len() as usize,
        );
        Ok(())
    }

    pub fn validate_complete(
        &self,
        key: &Key<'_>,
        analysis: &Analysis,
        documents: &[Document],
        plan: &WindowPlan,
        vectors: &[Vec<f32>],
    ) -> Result<()> {
        super::documents::validate(analysis, documents)?;
        ensure!(
            documents.len() == vectors.len(),
            "incomplete staged vectors"
        );
        let identity: (String, String, String, bool) = self.connection.query_row(
            "SELECT path,source_hash,policy,discovered FROM work WHERE run=?1 AND ordinal=?2",
            params![self.run, key.ordinal as i64],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )?;
        ensure!(
            identity
                == (
                    key.path.into(),
                    key.source_hash.into(),
                    key.policy.into(),
                    true
                ),
            "incomplete staged discovery"
        );
        for stage in [
            Stage::Source(analysis),
            Stage::Windows(documents, plan),
            Stage::Vectors(vectors),
        ] {
            let (table, count, payload) = stage.encode(key)?;
            let saved: (i64,Vec<u8>,i64) = self.connection.query_row(&format!("SELECT items,digest,length(payload) FROM {table} WHERE run=?1 AND ordinal=?2 AND source_hash=?3 AND policy=?4"), params![self.run,key.ordinal as i64,key.source_hash,key.policy], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).context("missing committed indexing stage")?;
            ensure!(
                saved
                    == (
                        count as i64,
                        Sha256::digest(&payload).to_vec(),
                        payload.len() as i64
                    ),
                "staged publication mismatch"
            );
        }
        Ok(())
    }

    pub fn remove(&mut self, key: &Key<'_>) -> Result<()> {
        self.connection.execute(
            "DELETE FROM work WHERE run=?1 AND ordinal=?2 AND source_hash=?3 AND policy=?4",
            params![self.run, key.ordinal as i64, key.source_hash, key.policy],
        )?;
        Ok(())
    }

    pub fn finish(self) -> Result<()> {
        let _cleanup = self.profile.scope("staging_cleanup");
        self.connection
            .execute("DELETE FROM runs WHERE id=?1", [&self.run])?;
        self.connection.execute_batch("VACUUM")?;
        Ok(())
    }
}

#[cfg(test)]
#[path = "../../tests/unit/storage_staging.rs"]
mod tests;
