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
    let analysis = crate::analysis::extract(source(path, text))?;
    let budget = crate::retrieval::split::TokenBudget::new(crate::test_support::tokenizer(512))?;
    let policy = policy::document_policy(&budget);
    let documents = crate::retrieval::source::documents(&analysis, &budget)?;
    let vectors = vec![vector(1.0, 0.0); documents.len()];
    documents::save(
        connection,
        &analysis,
        documents::Batch {
            documents: &documents,
            vectors: &vectors,
            policy: &policy,
        },
    )
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
        "source_snapshots",
        "entities",
        "analysis_records",
        "retrieval_documents",
        "retrieval_processing",
        "index_metadata",
        "document_embeddings",
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
