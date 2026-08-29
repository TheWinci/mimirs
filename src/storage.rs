use std::path::Path;
use std::sync::OnceLock;

use anyhow::Context;
use rusqlite::Connection;
use rusqlite::auto_extension::{RawAutoExtension, register_auto_extension};
use rusqlite_migration::{M, Migrations};

static VEC_REGISTRATION: OnceLock<Result<(), String>> = OnceLock::new();

const SCHEMA_V1: &str = r#"
CREATE TABLE files (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL UNIQUE
);

CREATE TABLE windows (
    id INTEGER PRIMARY KEY,
    file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    byte_start INTEGER NOT NULL CHECK (byte_start >= 0),
    byte_end INTEGER NOT NULL CHECK (byte_end >= byte_start),
    line_number INTEGER NOT NULL CHECK (line_number >= 1),
    text TEXT NOT NULL,
    UNIQUE (file_id, ordinal)
);

CREATE TABLE index_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
) WITHOUT ROWID;

CREATE VIRTUAL TABLE window_embeddings USING vec0(
    window_id INTEGER PRIMARY KEY,
    embedding FLOAT[384] distance_metric=cosine
);
"#;

const MIGRATION_LIST: &[M<'static>] =
    &[M::up(SCHEMA_V1).comment("create the initial vector index schema")];

const MIGRATIONS: Migrations<'static> = Migrations::from_slice(MIGRATION_LIST);

const SCHEMA_VERSION: usize = MIGRATION_LIST.len();

fn migrate(connection: &mut Connection) -> anyhow::Result<()> {
    let found: usize = MIGRATIONS
        .current_version(connection)
        .context("cannot read database schema version")?
        .into();

    if found > SCHEMA_VERSION {
        anyhow::bail!(
            "database schema version {found} is newer than supported version {SCHEMA_VERSION}"
        );
    }

    MIGRATIONS
        .to_latest(connection)
        .context("cannot migrate database")
}

fn register_vec() -> anyhow::Result<()> {
    let registration = VEC_REGISTRATION.get_or_init(|| unsafe {
        let entrypoint: RawAutoExtension =
            std::mem::transmute(sqlite_vec::sqlite3_vec_init as *const ());

        register_auto_extension(entrypoint).map_err(|error| error.to_string())
    });

    match registration {
        Ok(()) => Ok(()),
        Err(message) => {
            anyhow::bail!("cannot register bundled sqlite-vec: {message}")
        }
    }
}

pub fn open(path: &Path) -> anyhow::Result<Connection> {
    register_vec()?;
    let mut connection = Connection::open(path)
        .with_context(|| format!("cannot open database {}", path.display()))?;

    connection
        .pragma_update(None, "foreign_keys", false)
        .context("cannot disable database foreign keys for database migrations")?;

    migrate(&mut connection)?;

    connection
        .pragma_update(None, "foreign_keys", true)
        .context("cannot enable database foreign keys")?;

    Ok(connection)
}

#[cfg(test)]
#[path = "../tests/unit/storage.rs"]
mod tests;
