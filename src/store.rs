use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use rusqlite::auto_extension::{RawAutoExtension, register_auto_extension};
use rusqlite::{Connection, OpenFlags, OptionalExtension, Transaction, params};

use crate::chunk::Chunk;
use crate::embed::DIMENSION;
use crate::keywords;

/// Bump whenever the tables, the model, the tokenizer, or the chunking rules
/// change, so `index` rebuilds instead of mixing old and new data.
const SCHEMA_VERSION: i64 = 2;

const LAST_RUN_KEY: &str = "last_index_finished";

/// A file as recorded in the index.
pub struct FileRecord<'a> {
    /// Path relative to the project root, with `/` separators.
    pub path: &'a str,
    pub size: u64,
    /// Modification time in nanoseconds since the Unix epoch.
    pub modified: i64,
}

/// A chunk whose window was among the nearest to a query.
pub struct Hit {
    pub path: String,
    pub chunk_id: i64,
    pub start_line: usize,
    pub end_line: usize,
    pub text: String,
    /// Cosine similarity between the query and the window, higher is closer.
    pub score: f32,
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

    /// Open an existing index for queries. Fails with a hint to run `mimirs index`
    /// when there is no index or it was written by another schema version.
    pub fn open_existing(path: &Path) -> Result<Self> {
        register_sqlite_vec()?;
        anyhow::ensure!(path.exists(), "No index yet; run `mimirs index` first");
        // Read-write without create: WAL readers need to update the shared-memory file.
        let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
        let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
        anyhow::ensure!(
            version == SCHEMA_VERSION,
            "The index format changed; run `mimirs index` to rebuild it"
        );
        Ok(Self { connection })
    }

    pub fn file_count(&self) -> Result<usize> {
        let count: i64 = self
            .connection
            .query_row("SELECT count(*) FROM files", [], |row| row.get(0))?;
        Ok(count as usize)
    }

    /// Seconds since the Unix epoch when the last `index` run finished.
    pub fn last_finished_run(&self) -> Result<Option<i64>> {
        let finished = self
            .connection
            .query_row(
                "SELECT value FROM meta WHERE key = ?1",
                [LAST_RUN_KEY],
                |row| row.get(0),
            )
            .optional()?;
        Ok(finished)
    }

    /// The chunks of the `limit` windows nearest to `query`, closest first. A chunk
    /// appears once per matching window.
    pub fn nearest(&self, query: &[f32], limit: usize) -> Result<Vec<Hit>> {
        let mut statement = self.connection.prepare(
            "SELECT files.path, chunks.id, chunks.start_line, chunks.end_line, chunks.text,
                    window_vectors.distance
             FROM window_vectors
             JOIN windows ON windows.id = window_vectors.window_id
             JOIN chunks ON chunks.id = windows.chunk_id
             JOIN files ON files.id = chunks.file_id
             WHERE window_vectors.embedding MATCH ?1 AND k = ?2
             ORDER BY window_vectors.distance",
        )?;
        let rows = statement.query_map(params![vector_bytes(query), limit as i64], |row| {
            let start_line: i64 = row.get(2)?;
            let end_line: i64 = row.get(3)?;
            let distance: f64 = row.get(5)?;
            Ok(Hit {
                path: row.get(0)?,
                chunk_id: row.get(1)?,
                start_line: start_line as usize,
                end_line: end_line as usize,
                text: row.get(4)?,
                score: (1.0 - distance) as f32,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
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
        delete_file(&transaction, file.path)?;
        transaction.execute(
            "INSERT INTO files (path, size, modified) VALUES (?1, ?2, ?3)",
            params![file.path, file.size as i64, file.modified],
        )?;
        let file_id = transaction.last_insert_rowid();

        let path_terms = keywords::terms(file.path).join(" ");
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
            transaction.execute(
                "INSERT INTO chunk_terms (rowid, path, text) VALUES (?1, ?2, ?3)",
                params![chunk_id, path_terms, keywords::terms(&chunk.text).join(" ")],
            )?;
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

    /// Size and modification time of every indexed file, by path.
    pub fn file_states(&self) -> Result<HashMap<String, (u64, i64)>> {
        let mut statement = self
            .connection
            .prepare("SELECT path, size, modified FROM files")?;
        let rows = statement.query_map([], |row| {
            let size: i64 = row.get(1)?;
            Ok((row.get(0)?, (size as u64, row.get(2)?)))
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Delete every file whose path is not in `keep`, returning how many were removed.
    pub fn remove_files_except(&mut self, keep: &HashSet<String>) -> Result<usize> {
        let stored_paths: Vec<String> = self.file_states()?.into_keys().collect();
        let transaction = self.connection.transaction()?;
        let mut removed = 0;
        for path in stored_paths.iter().filter(|path| !keep.contains(*path)) {
            delete_file(&transaction, path)?;
            removed += 1;
        }
        transaction.commit()?;
        Ok(removed)
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

/// Delete a file with its chunks, windows, vectors, and keyword rows.
fn delete_file(transaction: &Transaction, path: &str) -> Result<()> {
    // Virtual tables have no cascading deletes, so remove their rows first. A
    // keyword row left behind would give its terms to a later chunk that reuses
    // the ID.
    transaction.execute(
        "DELETE FROM window_vectors WHERE window_id IN (
             SELECT windows.id FROM windows
             JOIN chunks ON chunks.id = windows.chunk_id
             JOIN files ON files.id = chunks.file_id
             WHERE files.path = ?1)",
        [path],
    )?;
    transaction.execute(
        "DELETE FROM chunk_terms WHERE rowid IN (
             SELECT chunks.id FROM chunks
             JOIN files ON files.id = chunks.file_id
             WHERE files.path = ?1)",
        [path],
    )?;
    transaction.execute("DELETE FROM files WHERE path = ?1", [path])?;
    Ok(())
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
         -- Contentless: holds only the search index; the text lives in chunks.
         CREATE VIRTUAL TABLE chunk_terms USING fts5 (
             path, text, content = '', contentless_delete = 1
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
        assert_eq!(count(&store, "chunk_terms")?, 2);
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

    #[test]
    fn nearest_returns_the_closest_chunks_first() -> Result<()> {
        let folder = tempfile::tempdir()?;
        let mut store = Store::open(&folder.path().join("index.db"))?;
        store.write_file(
            &record("src/a.rs"),
            &[chunk_with_windows(1, 1)],
            &[unit_vector(0)],
        )?;
        store.write_file(
            &record("src/b.rs"),
            &[chunk_with_windows(7, 1)],
            &[unit_vector(1)],
        )?;
        let hits = store.nearest(&unit_vector(1), 10)?;
        assert_eq!(hits.len(), 2);
        assert_eq!((hits[0].path.as_str(), hits[0].start_line), ("src/b.rs", 7));
        assert!((hits[0].score - 1.0).abs() < 1e-6);
        assert_eq!(store.file_count()?, 2);
        Ok(())
    }

    #[test]
    fn opening_for_queries_requires_a_matching_index() -> Result<()> {
        let folder = tempfile::tempdir()?;
        let path = folder.path().join("index.db");
        assert!(Store::open_existing(&path).is_err());
        assert!(!path.exists(), "queries must not create an index");

        let store = Store::open(&path)?;
        store
            .connection
            .pragma_update(None, "user_version", SCHEMA_VERSION + 1)?;
        drop(store);
        let error = Store::open_existing(&path)
            .err()
            .context("expected an error")?;
        assert!(error.to_string().contains("mimirs index"));
        Ok(())
    }

    #[test]
    fn removes_files_that_are_not_kept() -> Result<()> {
        let folder = tempfile::tempdir()?;
        let mut store = Store::open(&folder.path().join("index.db"))?;
        for path in ["a.rs", "b.rs", "c.rs"] {
            store.write_file(
                &record(path),
                &[chunk_with_windows(1, 1)],
                &[unit_vector(0)],
            )?;
        }
        let keep: HashSet<String> = ["b.rs".to_string()].into();
        assert_eq!(store.remove_files_except(&keep)?, 2);

        let states = store.file_states()?;
        assert_eq!(states.len(), 1);
        assert_eq!(states["b.rs"], (10, 1));
        assert_eq!(count(&store, "chunks")?, 1);
        assert_eq!(count(&store, "window_vectors")?, 1);
        assert_eq!(count(&store, "chunk_terms")?, 1);
        Ok(())
    }

    fn keyword_matches(store: &Store, expression: &str) -> Result<Vec<i64>> {
        let mut statement = store
            .connection
            .prepare("SELECT rowid FROM chunk_terms WHERE chunk_terms MATCH ?1 ORDER BY rowid")?;
        let rows = statement.query_map([expression], |row| row.get(0))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    #[test]
    fn keyword_rows_follow_their_chunks() -> Result<()> {
        let folder = tempfile::tempdir()?;
        let mut store = Store::open(&folder.path().join("index.db"))?;
        let mut chunk = chunk_with_windows(1, 1);
        chunk.text = "fn rrfFuse() {}".into();
        store.write_file(&record("src/hybrid.rs"), &[chunk], &[unit_vector(0)])?;
        assert_eq!(keyword_matches(&store, "fuse")?.len(), 1);
        assert_eq!(keyword_matches(&store, "path: hybrid")?.len(), 1);

        let mut chunk = chunk_with_windows(1, 1);
        chunk.text = "fn cookPasta() {}".into();
        store.write_file(&record("src/hybrid.rs"), &[chunk], &[unit_vector(0)])?;
        assert!(keyword_matches(&store, "fuse")?.is_empty());
        assert_eq!(keyword_matches(&store, "pasta")?.len(), 1);

        store.remove_files_except(&HashSet::new())?;
        assert!(keyword_matches(&store, "pasta")?.is_empty());
        Ok(())
    }
}
