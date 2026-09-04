use std::fs;
use std::path::Path;
use std::sync::OnceLock;

use anyhow::{Context, ensure};
use rusqlite::auto_extension::{RawAutoExtension, register_auto_extension};
use rusqlite::{Connection, OpenFlags};

static VEC_REGISTRATION: OnceLock<Result<(), String>> = OnceLock::new();

// Alpha versions identify rebuilds, not positions in a migration list.
// Keep rusqlite_migration for the baseline before database compatibility is promised.
const SCHEMA_VERSION: i64 = 2;
const SCHEMA: &str = include_str!("storage/schema.sql");
// Used only to recognize old databases, never to upgrade their rows.
const SCHEMA_V1: &str = include_str!("storage/schema_v1.sql");

#[derive(Debug, PartialEq, Eq)]
pub enum OpenOutcome {
    Created,
    Reused,
    Rebuilt,
}

impl OpenOutcome {
    pub fn message(&self, path: &Path) -> String {
        match self {
            Self::Created => format!("created {}", path.display()),
            Self::Reused => format!("{} already up to date", path.display()),
            Self::Rebuilt => format!(
                "rebuilt {} for schema version {SCHEMA_VERSION}",
                path.display()
            ),
        }
    }
}

#[derive(Debug)]
pub struct OpenedDatabase {
    pub connection: Connection,
    pub outcome: OpenOutcome,
}

fn register_vec() -> anyhow::Result<()> {
    let registration = VEC_REGISTRATION.get_or_init(|| unsafe {
        let entrypoint: RawAutoExtension =
            std::mem::transmute(sqlite_vec::sqlite3_vec_init as *const ());

        register_auto_extension(entrypoint).map_err(|error| error.to_string())
    });

    match registration {
        Ok(()) => Ok(()),
        Err(message) => anyhow::bail!("cannot register bundled sqlite-vec: {message}"),
    }
}

// Include indexes and vec0's shadow tables so partial or foreign schemas fail
// recognition. Ignore formatting, but retain every SQL token and object name.
fn schema_objects(connection: &Connection) -> anyhow::Result<Vec<(String, String, String)>> {
    let mut statement = connection.prepare(
        "SELECT type, name, coalesce(sql, '') FROM sqlite_schema
         WHERE name NOT GLOB 'sqlite_*' ORDER BY type, name",
    )?;
    let rows = statement.query_map([], |row| {
        let sql: String = row.get(2)?;
        Ok((
            row.get(0)?,
            row.get(1)?,
            sql.split_whitespace().collect::<Vec<_>>().join(" "),
        ))
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

fn validate_schema(connection: &Connection, schema: &str) -> anyhow::Result<()> {
    let reference = Connection::open_in_memory()?;
    reference.execute_batch(schema)?;
    ensure!(
        schema_objects(connection)? == schema_objects(&reference)?,
        "unknown or damaged database schema"
    );
    let integrity: String = connection.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
    ensure!(integrity == "ok", "damaged database: {integrity}");
    let mut foreign_keys = connection.prepare("PRAGMA foreign_key_check")?;
    ensure!(
        foreign_keys.query([])?.next()?.is_none(),
        "damaged database: broken foreign keys"
    );
    Ok(())
}

pub fn open(path: &Path) -> anyhow::Result<OpenedDatabase> {
    open_at(path).with_context(|| format!("cannot open database {}", path.display()))
}

pub fn open_read_only(path: &Path) -> anyhow::Result<Connection> {
    let read = || -> anyhow::Result<Connection> {
        register_vec()?;
        ensure!(
            path.try_exists()?,
            "index is missing; run mimirs init or mimirs index"
        );
        let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let found = validate_version(&connection)?;
        ensure!(
            found == SCHEMA_VERSION,
            "index schema version {found} is older than supported version {SCHEMA_VERSION}; run mimirs init or mimirs index"
        );
        Ok(connection)
    };
    read().with_context(|| format!("cannot read database {}", path.display()))
}

fn validate_version(connection: &Connection) -> anyhow::Result<i64> {
    let found: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    ensure!(
        found <= SCHEMA_VERSION,
        "database schema version {found} is newer than supported version {SCHEMA_VERSION}"
    );
    let schema = match found {
        1 => SCHEMA_V1,
        SCHEMA_VERSION => SCHEMA,
        _ => anyhow::bail!("unknown database schema version {found}"),
    };
    validate_schema(connection, schema)?;
    Ok(found)
}

fn open_at(path: &Path) -> anyhow::Result<OpenedDatabase> {
    register_vec()?;
    let outcome = if path.try_exists()? {
        // Inspect without allowing SQLite to modify an unrecognized database.
        let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let found = validate_version(&connection)?;
        connection.close().map_err(|(_, error)| error)?;
        if found == SCHEMA_VERSION {
            OpenOutcome::Reused
        } else {
            // Rebuilding only the main file cannot safely preserve a journal.
            for suffix in ["-wal", "-shm", "-journal"] {
                let mut sidecar = path.as_os_str().to_owned();
                sidecar.push(suffix);
                ensure!(
                    !Path::new(&sidecar).try_exists()?,
                    "cannot rebuild database with SQLite sidecar {}",
                    Path::new(&sidecar).display()
                );
            }
            fs::remove_file(path).context("cannot remove older alpha database")?;
            OpenOutcome::Rebuilt
        }
    } else {
        OpenOutcome::Created
    };

    let mut connection = Connection::open(path)?;
    if outcome != OpenOutcome::Reused {
        let transaction = connection.transaction()?;
        transaction.execute_batch(SCHEMA)?;
        transaction.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        transaction.commit()?;
    }
    connection.pragma_update(None, "foreign_keys", true)?;
    Ok(OpenedDatabase {
        connection,
        outcome,
    })
}

mod reconcile;
mod save;
mod search;
pub use reconcile::reconcile;
pub use save::{save_file, validate_model};
pub use search::{SearchResult, has_windows, nearest};

#[cfg(test)]
#[path = "../tests/unit/storage.rs"]
mod tests;
