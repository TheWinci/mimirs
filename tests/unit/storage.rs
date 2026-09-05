use tempfile::TempDir;

use super::*;

#[path = "storage/open.rs"]
mod open;
#[path = "storage/reconcile.rs"]
mod reconcile;
#[path = "storage/save.rs"]
mod save;
#[path = "storage/search.rs"]
mod search;

fn source(path: &str, text: &str) -> crate::source::SourceFile {
    crate::source::SourceFile {
        path: path.into(),
        text: text.into(),
    }
}

fn vector(x: f32, y: f32) -> Vec<f32> {
    let mut vector = vec![0.0; crate::embedding::DIMENSION];
    vector[0] = x;
    vector[1] = y;
    vector
}

fn save_text(connection: &mut Connection, path: &str, text: &str) -> anyhow::Result<()> {
    let source = source(path, text);
    let chunks = crate::chunk::of(&source);
    let windows = crate::window::of(&chunks[0]);
    let vectors = vec![vector(1.0, 0.0); windows.len()];
    save_file(connection, &source, &chunks, &windows, &vectors, None)
}

fn count(connection: &Connection, table: &str) -> i64 {
    connection
        .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .unwrap()
}

// Capture every user row, including vector bytes, to prove failed operations
// preserve values and IDs rather than just row counts.
fn snapshot(connection: &Connection) -> Vec<Vec<Vec<rusqlite::types::Value>>> {
    [
        "files",
        "chunks",
        "windows",
        "index_metadata",
        "window_embeddings",
    ]
    .iter()
    .map(|table| {
        let mut statement = connection
            .prepare(&format!("SELECT * FROM {table} ORDER BY 1"))
            .unwrap();
        let columns = statement.column_count();
        statement
            .query_map([], |row| {
                (0..columns).map(|column| row.get(column)).collect()
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
    })
    .collect()
}

fn vector_bytes(vector: &[f32]) -> Vec<u8> {
    vector
        .iter()
        .flat_map(|value| value.to_ne_bytes())
        .collect()
}
