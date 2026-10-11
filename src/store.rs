use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::Result;
use rusqlite::auto_extension::{RawAutoExtension, register_auto_extension};
use rusqlite::{Connection, OpenFlags, OptionalExtension, Transaction, params};

use crate::chunk::{self, Chunk};
use crate::embed::DIMENSION;
use crate::keywords;

/// Bump whenever the tables, the model, the tokenizer, or the chunking rules
/// change, so `index` rebuilds instead of mixing old and new data.
const SCHEMA_VERSION: i64 = 6;

const LAST_RUN_KEY: &str = "last_index_finished";

/// A file as recorded in the index.
pub struct FileRecord<'a> {
    /// Path relative to the project root, with `/` separators.
    pub path: &'a str,
    pub size: u64,
    /// Modification time in nanoseconds since the Unix epoch.
    pub modified: i64,
}

/// A chunk that one search found for a query.
pub struct Hit {
    pub path: String,
    pub chunk_id: i64,
    /// How well the chunk matches by the measure of the search that found it,
    /// higher is better: cosine similarity for vectors, negated BM25 for keywords.
    pub score: f32,
}

/// A file's text and chunks as stored, for building excerpts.
pub struct StoredFile {
    pub text: String,
    /// The database ID of each chunk in `chunks`, in the same order.
    pub chunk_ids: Vec<i64>,
    pub chunks: Vec<Chunk>,
}

/// A chunk's full name with its parents' (`Queue.drain`).
pub struct ChunkName {
    pub full: String,
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
            "SELECT files.path, chunks.id, window_vectors.distance
             FROM window_vectors
             JOIN windows ON windows.id = window_vectors.window_id
             JOIN chunks ON chunks.id = windows.chunk_id
             JOIN files ON files.id = chunks.file_id
             WHERE window_vectors.embedding MATCH ?1 AND k = ?2
             ORDER BY window_vectors.distance",
        )?;
        let rows = statement.query_map(params![vector_bytes(query), limit as i64], |row| {
            let distance: f64 = row.get(2)?;
            Ok(Hit {
                path: row.get(0)?,
                chunk_id: row.get(1)?,
                score: (1.0 - distance) as f32,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// The vector score of each chunk in `chunk_ids`, as `nearest` scores it:
    /// the cosine similarity of its best window to `query`. Chunks without
    /// windows are left out.
    pub fn vector_scores(&self, query: &[f32], chunk_ids: &[i64]) -> Result<Vec<Hit>> {
        let mut statement = self.connection.prepare(
            "SELECT files.path, chunks.id,
                    MIN(vec_distance_cosine(window_vectors.embedding, ?1))
             FROM windows
             JOIN window_vectors ON window_vectors.window_id = windows.id
             JOIN chunks ON chunks.id = windows.chunk_id
             JOIN files ON files.id = chunks.file_id
             WHERE windows.chunk_id = ?2
             GROUP BY chunks.id",
        )?;
        let query_bytes = vector_bytes(query);
        let mut hits = Vec::new();
        for chunk_id in chunk_ids {
            let mut rows = statement.query(params![query_bytes, chunk_id])?;
            if let Some(row) = rows.next()? {
                let distance: f64 = row.get(2)?;
                hits.push(Hit {
                    path: row.get(0)?,
                    chunk_id: row.get(1)?,
                    score: (1.0 - distance) as f32,
                });
            }
        }
        Ok(hits)
    }

    /// The BM25 score of each chunk in `chunk_ids` for an FTS5 `expression`, as
    /// `keyword_matches` scores it. Chunks the expression does not match are
    /// left out.
    pub fn keyword_scores(&self, expression: &str, chunk_ids: &[i64]) -> Result<Vec<Hit>> {
        let mut statement = self.connection.prepare(
            "SELECT files.path, chunks.id, bm25(chunk_terms, 2.0, 3.0, 1.0)
             FROM chunk_terms
             JOIN chunks ON chunks.id = chunk_terms.rowid
             JOIN files ON files.id = chunks.file_id
             WHERE chunk_terms MATCH ?1 AND chunk_terms.rowid = ?2",
        )?;
        let mut hits = Vec::new();
        for chunk_id in chunk_ids {
            let mut rows = statement.query(params![expression, chunk_id])?;
            if let Some(row) = rows.next()? {
                let bm25_value: f64 = row.get(2)?;
                hits.push(Hit {
                    path: row.get(0)?,
                    chunk_id: row.get(1)?,
                    score: -bm25_value as f32,
                });
            }
        }
        Ok(hits)
    }

    /// The path and ID of every chunk whose own name is `name`, ignoring case.
    pub fn chunks_named(&self, name: &str) -> Result<Vec<(String, i64)>> {
        let mut statement = self.connection.prepare(
            "SELECT files.path, chunks.id
             FROM chunks JOIN files ON files.id = chunks.file_id
             WHERE chunks.name = ?1 COLLATE NOCASE
             ORDER BY files.path, chunks.start_byte, chunks.id",
        )?;
        let rows = statement.query_map([name], |row| Ok((row.get(0)?, row.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// The full name of each named chunk in `chunk_ids`; unnamed
    /// chunks are left out. Full names follow `chunk::full_name`.
    pub fn chunk_names(&self, chunk_ids: &[i64]) -> Result<HashMap<i64, ChunkName>> {
        let mut statement = self
            .connection
            .prepare("SELECT name, parent_id, kind FROM chunks WHERE id = ?1")?;
        let mut names = HashMap::new();
        for &chunk_id in chunk_ids {
            let mut parts: Vec<String> = Vec::new();
            let mut is_section = false;
            let mut current = Some(chunk_id);
            while let Some(id) = current {
                let (name, parent, kind): (Option<String>, Option<i64>, String) =
                    statement.query_row([id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
                if id == chunk_id {
                    if name.is_none() {
                        break;
                    }
                    is_section = kind == "section";
                }
                parts.extend(name);
                current = parent;
            }
            if parts.is_empty() {
                continue;
            }
            parts.reverse();
            let separator = if is_section { " > " } else { "." };
            let full = parts.join(separator);
            names.insert(chunk_id, ChunkName { full });
        }
        Ok(names)
    }

    /// The paths of the `limit` files whose whole text best matches an FTS5
    /// `expression` by BM25, best first. Weights per column: path 2, text 1.
    pub fn file_matches(&self, expression: &str, limit: usize) -> Result<Vec<String>> {
        let mut statement = self.connection.prepare(
            "SELECT files.path
             FROM file_terms
             JOIN files ON files.id = file_terms.rowid
             WHERE file_terms MATCH ?1
             ORDER BY bm25(file_terms, 2.0, 1.0), files.id
             LIMIT ?2",
        )?;
        let rows = statement.query_map(params![expression, limit as i64], |row| row.get(0))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// The `limit` chunks that best match an FTS5 `expression` by BM25, best first.
    pub fn keyword_matches(&self, expression: &str, limit: usize) -> Result<Vec<Hit>> {
        // Weights per column: path 2, name 3, text 1. bm25() is lower for better
        // matches.
        let mut statement = self.connection.prepare(
            "SELECT files.path, chunks.id, bm25(chunk_terms, 2.0, 3.0, 1.0) AS bm25_value
             FROM chunk_terms
             JOIN chunks ON chunks.id = chunk_terms.rowid
             JOIN files ON files.id = chunks.file_id
             WHERE chunk_terms MATCH ?1
             ORDER BY bm25_value, chunks.id
             LIMIT ?2",
        )?;
        let rows = statement.query_map(params![expression, limit as i64], |row| {
            let bm25_value: f64 = row.get(2)?;
            Ok(Hit {
                path: row.get(0)?,
                chunk_id: row.get(1)?,
                score: -bm25_value as f32,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Replace one file's text, chunks, windows, and vectors in a single
    /// transaction. `vectors_per_chunk` holds each chunk's window vectors, in
    /// chunk order.
    pub fn write_file(
        &mut self,
        file: &FileRecord,
        text: &str,
        chunks: &[Chunk],
        vectors_per_chunk: &[Vec<Vec<f32>>],
    ) -> Result<()> {
        anyhow::ensure!(
            chunks.len() == vectors_per_chunk.len(),
            "Expected the vectors of every chunk"
        );

        let transaction = self.connection.transaction()?;
        delete_file(&transaction, file.path)?;
        transaction.execute(
            "INSERT INTO files (path, size, modified, text) VALUES (?1, ?2, ?3, ?4)",
            params![file.path, file.size as i64, file.modified, text],
        )?;
        let file_id = transaction.last_insert_rowid();

        let path_terms = keywords::terms(file.path).join(" ");
        transaction.execute(
            "INSERT INTO file_terms (rowid, path, text) VALUES (?1, ?2, ?3)",
            params![file_id, path_terms, keywords::terms(text).join(" ")],
        )?;
        // The database ID of each chunk written so far, by its index in `chunks`.
        let mut chunk_ids: Vec<i64> = Vec::new();
        for (index, (chunk, vectors)) in chunks.iter().zip(vectors_per_chunk).enumerate() {
            let parent_id = match chunk.parent {
                Some(parent) => Some(
                    *chunk_ids
                        .get(parent)
                        .ok_or_else(|| anyhow::anyhow!("A chunk came before its parent"))?,
                ),
                None => None,
            };
            let body_start = chunk.body.as_ref().map(|body| body.start as i64);
            let body_end = chunk.body.as_ref().map(|body| body.end as i64);
            transaction.execute(
                "INSERT INTO chunks (file_id, parent_id, kind, name, start_byte, end_byte,
                                     start_line, end_line, body_start, body_end)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    file_id,
                    parent_id,
                    chunk.kind,
                    chunk.name,
                    chunk.bytes.start as i64,
                    chunk.bytes.end as i64,
                    chunk.start_line as i64,
                    chunk.end_line as i64,
                    body_start,
                    body_end
                ],
            )?;
            let chunk_id = transaction.last_insert_rowid();
            chunk_ids.push(chunk_id);

            let name_terms = chunk::full_name(chunks, index)
                .map(|name| keywords::terms(&name).join(" "))
                .unwrap_or_default();
            let text_terms = keywords::terms(&chunk::own_text(text, chunks, index)).join(" ");
            transaction.execute(
                "INSERT INTO chunk_terms (rowid, path, name, text) VALUES (?1, ?2, ?3, ?4)",
                params![chunk_id, path_terms, name_terms, text_terms],
            )?;
            for vector in vectors {
                transaction.execute("INSERT INTO windows (chunk_id) VALUES (?1)", [chunk_id])?;
                let window_id = transaction.last_insert_rowid();
                transaction.execute(
                    "INSERT INTO window_vectors (window_id, embedding) VALUES (?1, ?2)",
                    params![window_id, vector_bytes(vector)],
                )?;
            }
        }
        transaction.commit()?;
        Ok(())
    }

    /// A file's text and all of its chunks, parents before children.
    pub fn stored_file(&self, path: &str) -> Result<StoredFile> {
        let text: String =
            self.connection
                .query_row("SELECT text FROM files WHERE path = ?1", [path], |row| {
                    row.get(0)
                })?;
        let mut statement = self.connection.prepare(
            "SELECT chunks.id, chunks.parent_id, chunks.kind, chunks.name,
                    chunks.start_byte, chunks.end_byte, chunks.start_line, chunks.end_line,
                    chunks.body_start, chunks.body_end
             FROM chunks JOIN files ON files.id = chunks.file_id
             WHERE files.path = ?1
             ORDER BY chunks.id",
        )?;
        let rows = statement.query_map([path], |row| {
            let parent_id: Option<i64> = row.get(1)?;
            let start_byte: i64 = row.get(4)?;
            let end_byte: i64 = row.get(5)?;
            let start_line: i64 = row.get(6)?;
            let end_line: i64 = row.get(7)?;
            let body_start: Option<i64> = row.get(8)?;
            let body_end: Option<i64> = row.get(9)?;
            let body = match (body_start, body_end) {
                (Some(start), Some(end)) => Some(start as usize..end as usize),
                _ => None,
            };
            let row_id: i64 = row.get(0)?;
            Ok((
                row_id,
                parent_id,
                Chunk {
                    kind: row.get(2)?,
                    name: row.get(3)?,
                    parent: None,
                    bytes: start_byte as usize..end_byte as usize,
                    start_line: start_line as usize,
                    end_line: end_line as usize,
                    body,
                },
            ))
        })?;

        let mut chunk_ids = Vec::new();
        let mut chunks = Vec::new();
        // Chunks are written parents first, so IDs order parents before children.
        for row in rows {
            let (chunk_id, parent_id, mut chunk) = row?;
            chunk.parent =
                parent_id.and_then(|parent_id| chunk_ids.iter().position(|id| *id == parent_id));
            chunk_ids.push(chunk_id);
            chunks.push(chunk);
        }
        Ok(StoredFile {
            text,
            chunk_ids,
            chunks,
        })
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
    /// Remove the given files and their chunks and vectors in one transaction.
    pub fn remove_files(&mut self, paths: &[String]) -> Result<()> {
        let transaction = self.connection.transaction()?;
        for path in paths {
            delete_file(&transaction, path)?;
        }
        transaction.commit()?;
        Ok(())
    }

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
    transaction.execute(
        "DELETE FROM file_terms WHERE rowid IN (SELECT id FROM files WHERE path = ?1)",
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
             modified INTEGER NOT NULL,
             text TEXT NOT NULL
         );
         -- A chunk is one span of its file; its own text is the span minus its
         -- children's bodies, so no chunk text is stored.
         CREATE TABLE chunks (
             id INTEGER PRIMARY KEY,
             file_id INTEGER NOT NULL REFERENCES files (id) ON DELETE CASCADE,
             parent_id INTEGER REFERENCES chunks (id) ON DELETE CASCADE,
             kind TEXT NOT NULL,
             name TEXT,
             start_byte INTEGER NOT NULL,
             end_byte INTEGER NOT NULL,
             start_line INTEGER NOT NULL,
             end_line INTEGER NOT NULL,
             body_start INTEGER,
             body_end INTEGER
         );
         CREATE INDEX chunks_by_file ON chunks (file_id);
         CREATE INDEX chunks_by_parent ON chunks (parent_id);
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
             path, name, text, content = '', contentless_delete = 1
         );
         -- One row per file: its path and whole text, for whole-file BM25.
         CREATE VIRTUAL TABLE file_terms USING fts5 (
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
    use crate::chunk::line_chunks;
    use anyhow::Context;

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

    /// Write `text` as line chunks, giving every chunk `windows` vectors along `axis`.
    fn write(store: &mut Store, path: &str, text: &str, windows: usize, axis: usize) -> Result<()> {
        let chunks = line_chunks(text);
        let vectors: Vec<Vec<Vec<f32>>> = chunks
            .iter()
            .map(|_| vec![unit_vector(axis); windows])
            .collect();
        store.write_file(&record(path), text, &chunks, &vectors)
    }

    #[test]
    fn writing_a_file_again_replaces_its_records() -> Result<()> {
        let folder = tempfile::tempdir()?;
        let mut store = Store::open(&folder.path().join("index.db"))?;
        write(&mut store, "src/a.rs", "fn a() {}\n", 2, 0)?;
        write(&mut store, "src/b.rs", "fn b() {}\n", 1, 0)?;
        assert_eq!(count(&store, "windows")?, 3);

        write(&mut store, "src/a.rs", "fn a() {}\n", 1, 0)?;
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
        write(&mut store, "src/a.rs", "fn a() {}\n", 1, 0)?;
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
        write(&mut store, "src/a.rs", "fn a() {}\n", 1, 0)?;
        write(&mut store, "src/b.rs", "fn b() {}\n", 1, 1)?;
        let hits = store.nearest(&unit_vector(1), 10)?;
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].path, "src/b.rs");
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
            write(&mut store, path, "fn f() {}\n", 1, 0)?;
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

    fn keyword_rows(store: &Store, expression: &str) -> Result<Vec<i64>> {
        let mut statement = store
            .connection
            .prepare("SELECT rowid FROM chunk_terms WHERE chunk_terms MATCH ?1 ORDER BY rowid")?;
        let rows = statement.query_map([expression], |row| row.get(0))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    #[test]
    fn vector_scores_score_each_chunk_by_its_best_window() -> Result<()> {
        let folder = tempfile::tempdir()?;
        let mut store = Store::open(&folder.path().join("index.db"))?;
        write(&mut store, "src/a.rs", "fn a() {}\n", 2, 0)?;
        write(&mut store, "src/b.rs", "fn b() {}\n", 1, 1)?;
        let chunk_of = |path: &str| -> Result<i64> {
            Ok(store.connection.query_row(
                "SELECT chunks.id FROM chunks JOIN files ON files.id = chunks.file_id
                 WHERE files.path = ?1",
                [path],
                |row| row.get(0),
            )?)
        };
        let a = chunk_of("src/a.rs")?;
        let b = chunk_of("src/b.rs")?;
        let hits = store.vector_scores(&unit_vector(0), &[a, b, 999])?;
        assert_eq!(hits.len(), 2);
        assert_eq!((hits[0].chunk_id, hits[1].chunk_id), (a, b));
        assert!((hits[0].score - 1.0).abs() < 1e-6);
        assert!(hits[1].score.abs() < 1e-6);
        Ok(())
    }

    #[test]
    fn keyword_scores_match_keyword_matches_and_skip_misses() -> Result<()> {
        let folder = tempfile::tempdir()?;
        let mut store = Store::open(&folder.path().join("index.db"))?;
        write(&mut store, "src/pasta.rs", "fn boil() {}\n", 1, 0)?;
        write(&mut store, "src/other.rs", "fn cook() {}\n", 1, 0)?;
        let expression = "\"pasta\"";
        let matched = store.keyword_matches(expression, 10)?;
        let all_chunks: Vec<i64> = store
            .connection
            .prepare("SELECT id FROM chunks ORDER BY id")?
            .query_map([], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        let scored = store.keyword_scores(expression, &all_chunks)?;
        assert_eq!(scored.len(), 1);
        assert_eq!(scored[0].chunk_id, matched[0].chunk_id);
        assert_eq!(scored[0].score, matched[0].score);
        Ok(())
    }

    #[test]
    fn chunk_names_join_parent_names() -> Result<()> {
        let folder = tempfile::tempdir()?;
        let mut store = Store::open(&folder.path().join("index.db"))?;
        let text = "class Queue {\n  drain() {}\n}\n";
        let chunks = crate::chunk::chunk_file("src/queue.ts", text)?;
        let vectors: Vec<Vec<Vec<f32>>> = chunks.iter().map(|_| vec![unit_vector(0)]).collect();
        store.write_file(&record("src/queue.ts"), text, &chunks, &vectors)?;
        let ids = store.stored_file("src/queue.ts")?.chunk_ids;
        let names = store.chunk_names(&ids)?;
        let full_names: Vec<&str> = ids
            .iter()
            .filter_map(|id| names.get(id))
            .map(|name| name.full.as_str())
            .collect();
        assert_eq!(full_names, ["Queue", "Queue.drain"]);
        Ok(())
    }

    #[test]
    fn file_matches_follow_whole_files_and_forget_removed_ones() -> Result<()> {
        let folder = tempfile::tempdir()?;
        let mut store = Store::open(&folder.path().join("index.db"))?;
        write(
            &mut store,
            "src/queue.rs",
            "fn push() {}\nfn drain() {}\n",
            1,
            0,
        )?;
        write(&mut store, "src/drain.rs", "fn other() {}\n", 1, 0)?;
        write(&mut store, "src/cook.rs", "fn boil() {}\n", 1, 0)?;
        assert_eq!(
            store.file_matches("\"drain\"", 10)?,
            ["src/drain.rs", "src/queue.rs"]
        );
        store.remove_files_except(&HashSet::from(["src/cook.rs".to_string()]))?;
        assert!(store.file_matches("\"drain\"", 10)?.is_empty());
        assert_eq!(count(&store, "file_terms")?, 1);
        Ok(())
    }

    #[test]
    fn keyword_matches_rank_path_and_text_hits_best_first() -> Result<()> {
        let folder = tempfile::tempdir()?;
        let mut store = Store::open(&folder.path().join("index.db"))?;
        write(&mut store, "src/pasta.rs", "fn boil() {}\n", 1, 0)?;
        write(&mut store, "src/hybrid.rs", "fn rrfFuse() {}\n", 1, 0)?;
        write(&mut store, "src/other.rs", "fn cook() {}\n", 1, 0)?;
        let hits = store.keyword_matches("\"fuse\" OR \"pasta\"", 10)?;
        let paths: Vec<&str> = hits.iter().map(|hit| hit.path.as_str()).collect();
        assert_eq!(paths.len(), 2);
        assert!(paths.contains(&"src/pasta.rs") && paths.contains(&"src/hybrid.rs"));
        assert!(hits[0].score >= hits[1].score);
        Ok(())
    }

    #[test]
    fn keyword_rows_follow_their_chunks() -> Result<()> {
        let folder = tempfile::tempdir()?;
        let mut store = Store::open(&folder.path().join("index.db"))?;
        write(&mut store, "src/hybrid.rs", "fn rrfFuse() {}\n", 1, 0)?;
        assert_eq!(keyword_rows(&store, "fuse")?.len(), 1);
        assert_eq!(keyword_rows(&store, "path: hybrid")?.len(), 1);

        write(&mut store, "src/hybrid.rs", "fn cookPasta() {}\n", 1, 0)?;
        assert!(keyword_rows(&store, "fuse")?.is_empty());
        assert_eq!(keyword_rows(&store, "pasta")?.len(), 1);

        store.remove_files_except(&HashSet::new())?;
        assert!(keyword_rows(&store, "pasta")?.is_empty());
        Ok(())
    }

    #[test]
    fn a_stored_file_returns_its_text_and_chunk_tree() -> Result<()> {
        let folder = tempfile::tempdir()?;
        let mut store = Store::open(&folder.path().join("index.db"))?;
        let text = "class Queue { push() { a(); } }";
        let chunks = [
            Chunk {
                kind: "class".into(),
                name: Some("Queue".into()),
                parent: None,
                bytes: 0..text.len(),
                start_line: 1,
                end_line: 1,
                body: Some(12..text.len()),
            },
            Chunk {
                kind: "method".into(),
                name: Some("push".into()),
                parent: Some(0),
                bytes: 14..29,
                start_line: 1,
                end_line: 1,
                body: Some(21..29),
            },
        ];
        let vectors = [vec![unit_vector(0)], vec![unit_vector(1)]];
        store.write_file(&record("queue.ts"), text, &chunks, &vectors)?;

        let stored = store.stored_file("queue.ts")?;
        assert_eq!(stored.text, text);
        assert_eq!(stored.chunks.len(), 2);
        assert_eq!(stored.chunks[1].parent, Some(0));
        assert_eq!(stored.chunks[1].body, Some(21..29));
        // The method's full name and the class's outline are searchable.
        assert_eq!(
            keyword_rows(&store, "name: queue AND name: push")?,
            [stored.chunk_ids[1]]
        );
        assert_eq!(
            keyword_rows(&store, "text: push AND text: class")?,
            [stored.chunk_ids[0]]
        );
        Ok(())
    }
}
