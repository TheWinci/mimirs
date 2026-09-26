use std::path::Path;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use rusqlite::auto_extension::{RawAutoExtension, register_auto_extension};
use rusqlite::{Connection, params};

use crate::chunk::Chunk;
use crate::embed::DIMENSION;

/// Bump whenever the tables, the model, the tokenizer, or the chunking rules
/// change, so `index` rebuilds instead of mixing old and new data.
const SCHEMA_VERSION: i64 = 1;

const LAST_RUN_KEY: &str = "last_index_finished";

/// A file as recorded in the index.
pub struct FileRecord<'a> {
    /// Path relative to the project root, with `/` separators.
    pub path: &'a str,
    pub size: u64,
    /// Modification time in nanoseconds since the Unix epoch.
    pub modified: i64,
}

/// The project's index in `.mimirs/index.db`.
pub struct Store {
    connection: Connection,
}

impl Store {
    /// Open the index for writing, creating it when missing and rebuilding it when
    /// its schema version differs.
    pub fn open(path: &Path) -> Result<Self> {
        register_sqlite_vec()?;
        let mut connection = Connection::open(path)?;
        let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if version != SCHEMA_VERSION && has_tables(&connection)? {
            println!("The index format changed; rebuilding {}", path.display());
            drop(connection);
            remove_database(path)?;
            connection = Connection::open(path)?;
        }
        // WAL lets `context` read committed data while `index` writes.
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "foreign_keys", true)?;
        if version != SCHEMA_VERSION {
            create_schema(&connection)?;
        }
        Ok(Self { connection })
    }

    /// Replace one file's chunks, windows, and vectors in a single transaction.
    /// `vectors` holds one vector per window, in chunk and window order.
    pub fn write_file(
        &mut self,
        file: &FileRecord,
        chunks: &[Chunk],
        vectors: &[Vec<f32>],
    ) -> Result<()> {
        let window_count: usize = chunks.iter().map(|chunk| chunk.windows.len()).sum();
        anyhow::ensure!(
            window_count == vectors.len(),
            "Expected one vector per window"
        );

        let transaction = self.connection.transaction()?;
        // vec0 tables have no cascading deletes, so remove the vectors first.
        transaction.execute(
            "DELETE FROM window_vectors WHERE window_id IN (
                 SELECT windows.id FROM windows
                 JOIN chunks ON chunks.id = windows.chunk_id
                 JOIN files ON files.id = chunks.file_id
                 WHERE files.path = ?1)",
            [file.path],
        )?;
        transaction.execute("DELETE FROM files WHERE path = ?1", [file.path])?;
        transaction.execute(
            "INSERT INTO files (path, size, modified) VALUES (?1, ?2, ?3)",
            params![file.path, file.size as i64, file.modified],
        )?;
        let file_id = transaction.last_insert_rowid();

        let mut vectors = vectors.iter();
        for chunk in chunks {
            transaction.execute(
                "INSERT INTO chunks (file_id, start_line, end_line, text) VALUES (?1, ?2, ?3, ?4)",
                params![
                    file_id,
                    chunk.start_line as i64,
                    chunk.end_line as i64,
                    chunk.text
                ],
            )?;
            let chunk_id = transaction.last_insert_rowid();
            for _window in &chunk.windows {
                transaction.execute("INSERT INTO windows (chunk_id) VALUES (?1)", [chunk_id])?;
                let window_id = transaction.last_insert_rowid();
                let vector = vectors.next().context("Expected one vector per window")?;
                transaction.execute(
                    "INSERT INTO window_vectors (window_id, embedding) VALUES (?1, ?2)",
                    params![window_id, vector_bytes(vector)],
                )?;
            }
        }
        transaction.commit()?;
        Ok(())
    }

    /// Record that an `index` run finished now.
    pub fn record_finished_run(&self) -> Result<()> {
        let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs() as i64;
        self.connection.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2)
             ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            params![LAST_RUN_KEY, now],
        )?;
        Ok(())
    }
}

fn create_schema(connection: &Connection) -> Result<()> {
    connection.execute_batch(&format!(
        "CREATE TABLE files (
             id INTEGER PRIMARY KEY,
             path TEXT NOT NULL UNIQUE,
             size INTEGER NOT NULL,
             modified INTEGER NOT NULL
         );
         CREATE TABLE chunks (
             id INTEGER PRIMARY KEY,
             file_id INTEGER NOT NULL REFERENCES files (id) ON DELETE CASCADE,
             start_line INTEGER NOT NULL,
             end_line INTEGER NOT NULL,
             text TEXT NOT NULL
         );
         CREATE INDEX chunks_by_file ON chunks (file_id);
         CREATE TABLE windows (
             id INTEGER PRIMARY KEY,
             chunk_id INTEGER NOT NULL REFERENCES chunks (id) ON DELETE CASCADE
         );
         CREATE INDEX windows_by_chunk ON windows (chunk_id);
         CREATE VIRTUAL TABLE window_vectors USING vec0 (
             window_id INTEGER PRIMARY KEY,
             embedding FLOAT[{DIMENSION}] distance_metric=cosine
         );
         CREATE TABLE meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
         PRAGMA user_version = {SCHEMA_VERSION};"
    ))?;
    Ok(())
}

fn has_tables(connection: &Connection) -> Result<bool> {
    let count: i64 = connection.query_row(
        "SELECT count(*) FROM sqlite_schema WHERE type = 'table'",
        [],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

/// Delete the database together with its write-ahead log files.
fn remove_database(path: &Path) -> Result<()> {
    std::fs::remove_file(path)?;
    for suffix in ["-wal", "-shm"] {
        let mut side_file = path.as_os_str().to_owned();
        side_file.push(suffix);
        if Path::new(&side_file).exists() {
            std::fs::remove_file(side_file)?;
        }
    }
    Ok(())
}

fn vector_bytes(vector: &[f32]) -> Vec<u8> {
    vector
        .iter()
        .flat_map(|value| value.to_le_bytes())
        .collect()
}

/// Make the compiled-in sqlite-vec extension available to every connection.
fn register_sqlite_vec() -> Result<()> {
    static REGISTRATION: OnceLock<Result<(), String>> = OnceLock::new();
    let registration = REGISTRATION.get_or_init(|| {
        // SAFETY: sqlite3_vec_init has the signature SQLite expects of an
        // extension entry point; the transmute only restates that type.
        let result = unsafe {
            let entry_point: RawAutoExtension =
                std::mem::transmute(sqlite_vec::sqlite3_vec_init as *const ());
            register_auto_extension(entry_point)
        };
        result.map_err(|error| error.to_string())
    });
    match registration {
        Ok(()) => Ok(()),
        Err(message) => anyhow::bail!("Could not register sqlite-vec: {message}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chunk::Window;

    fn chunk_with_windows(start_line: usize, window_count: usize) -> Chunk {
        let text = "x".repeat(window_count);
        Chunk {
            start_line,
            end_line: start_line,
            windows: (0..window_count)
                .map(|index| Window {
                    start: index,
                    end: index + 1,
                })
                .collect(),
            text,
        }
    }

    fn unit_vector(axis: usize) -> Vec<f32> {
        let mut vector = vec![0.0; DIMENSION];
        vector[axis] = 1.0;
        vector
    }

    fn count(store: &Store, table: &str) -> Result<i64> {
        Ok(store
            .connection
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                row.get(0)
            })?)
    }

    fn record(path: &str) -> FileRecord<'_> {
        FileRecord {
            path,
            size: 10,
            modified: 1,
        }
    }

    #[test]
    fn writing_a_file_again_replaces_its_records() -> Result<()> {
        let folder = tempfile::tempdir()?;
        let mut store = Store::open(&folder.path().join("index.db"))?;
        let chunks = [chunk_with_windows(1, 2), chunk_with_windows(2, 1)];
        let vectors = [unit_vector(0), unit_vector(1), unit_vector(2)];
        store.write_file(&record("src/a.rs"), &chunks, &vectors)?;
        store.write_file(&record("src/b.rs"), &chunks[1..], &vectors[..1])?;
        assert_eq!(count(&store, "windows")?, 4);

        store.write_file(&record("src/a.rs"), &chunks[1..], &vectors[..1])?;
        assert_eq!(count(&store, "files")?, 2);
        assert_eq!(count(&store, "chunks")?, 2);
        assert_eq!(count(&store, "windows")?, 2);
        assert_eq!(count(&store, "window_vectors")?, 2);
        Ok(())
    }

    #[test]
    fn records_when_the_last_run_finished() -> Result<()> {
        let folder = tempfile::tempdir()?;
        let store = Store::open(&folder.path().join("index.db"))?;
        store.record_finished_run()?;
        store.record_finished_run()?;
        let finished: i64 = store.connection.query_row(
            "SELECT value FROM meta WHERE key = ?1",
            [LAST_RUN_KEY],
            |row| row.get(0),
        )?;
        assert!(finished > 0);
        Ok(())
    }

    #[test]
    fn a_schema_version_mismatch_rebuilds_the_index() -> Result<()> {
        let folder = tempfile::tempdir()?;
        let path = folder.path().join("index.db");
        let mut store = Store::open(&path)?;
        store.write_file(
            &record("src/a.rs"),
            &[chunk_with_windows(1, 1)],
            &[unit_vector(0)],
        )?;
        store
            .connection
            .pragma_update(None, "user_version", SCHEMA_VERSION + 1)?;
        drop(store);

        let store = Store::open(&path)?;
        assert_eq!(count(&store, "files")?, 0);
        let version: i64 = store
            .connection
            .pragma_query_value(None, "user_version", |row| row.get(0))?;
        assert_eq!(version, SCHEMA_VERSION);
        Ok(())
    }
}
