#![cfg_attr(not(test), expect(dead_code))]

use std::collections::HashMap;

use anyhow::{Context, ensure};
use rusqlite::{Connection, OptionalExtension, Transaction, params};

use crate::{chunk::Chunk, embedding, source::SourceFile, window::Window};

/// Replace a file atomically. Borrowed object identities become database IDs
/// only here; vectors correspond to windows by position.
pub fn save_file(
    connection: &mut Connection,
    source: &SourceFile,
    chunks: &[Chunk<'_>],
    windows: &[Window<'_, '_>],
    vectors: &[Vec<f32>],
    model_name: &str,
    dimension: usize,
) -> anyhow::Result<()> {
    let mut save = || -> anyhow::Result<()> {
        ensure!(
            model_name == embedding::MODEL_NAME && dimension == embedding::DIMENSION,
            "unsupported embedding model {model_name} with dimension {dimension}"
        );
        ensure!(
            windows.len() == vectors.len(),
            "{} windows have {} vectors",
            windows.len(),
            vectors.len()
        );

        let mut chunk_positions = HashMap::new();
        for (ordinal, chunk) in chunks.iter().enumerate() {
            ensure!(
                std::ptr::eq(chunk.source, source),
                "chunk {ordinal} does not reference the supplied source file"
            );
            chunk_positions.insert(std::ptr::from_ref(chunk), ordinal);
        }
        let mut window_chunks = Vec::with_capacity(windows.len());
        for (ordinal, (window, vector)) in windows.iter().zip(vectors).enumerate() {
            let position = chunk_positions
                .get(&std::ptr::from_ref(window.chunk))
                .with_context(|| format!("window {ordinal} does not reference a supplied chunk"))?;
            window_chunks.push(*position);
            ensure!(
                vector.len() == dimension,
                "vector {ordinal} has dimension {}, expected {dimension}",
                vector.len()
            );
            ensure!(
                vector.iter().all(|value| value.is_finite()),
                "vector {ordinal} contains a non-finite value"
            );
        }

        let transaction = connection.transaction()?;
        validate_metadata(&transaction, model_name, dimension)?;
        transaction.execute(
            "INSERT INTO files(path) VALUES (?1) ON CONFLICT(path) DO NOTHING",
            [&source.path],
        )?;
        let file_id: i64 = transaction.query_row(
            "SELECT id FROM files WHERE path = ?1",
            [&source.path],
            |row| row.get(0),
        )?;
        // vec0 has no foreign key cascade. Remove its rows before the window IDs.
        transaction.execute(
            "DELETE FROM window_embeddings WHERE window_id IN (
                SELECT w.id FROM windows w JOIN chunks c ON c.id = w.chunk_id WHERE c.file_id = ?1
            )",
            [file_id],
        )?;
        transaction.execute("DELETE FROM chunks WHERE file_id = ?1", [file_id])?;

        let mut chunk_ids = Vec::with_capacity(chunks.len());
        for (ordinal, chunk) in chunks.iter().enumerate() {
            transaction.execute(
                "INSERT INTO chunks(file_id, ordinal, text, byte_start, byte_end, line_start, line_end)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    file_id,
                    i64::try_from(ordinal)?,
                    chunk.text,
                    i64::try_from(chunk.byte_start)?,
                    i64::try_from(chunk.byte_end)?,
                    i64::try_from(chunk.line_start)?,
                    i64::try_from(chunk.line_end)?,
                ],
            )?;
            chunk_ids.push(transaction.last_insert_rowid());
        }
        let mut ordinals = vec![0usize; chunks.len()];
        for ((window, vector), chunk_position) in windows.iter().zip(vectors).zip(window_chunks) {
            transaction.execute(
                "INSERT INTO windows(chunk_id, ordinal, text) VALUES (?1, ?2, ?3)",
                params![
                    chunk_ids[chunk_position],
                    i64::try_from(ordinals[chunk_position])?,
                    window.text
                ],
            )?;
            let window_id = transaction.last_insert_rowid();
            let bytes: Vec<u8> = vector
                .iter()
                .flat_map(|value| value.to_ne_bytes())
                .collect();
            transaction.execute(
                "INSERT INTO window_embeddings(window_id, embedding) VALUES (?1, ?2)",
                params![window_id, bytes],
            )?;
            ordinals[chunk_position] += 1;
        }
        transaction.commit()?;
        Ok(())
    };
    save().with_context(|| format!("cannot save source file {}", source.path))
}

fn validate_metadata(
    transaction: &Transaction<'_>,
    model: &str,
    dimension: usize,
) -> anyhow::Result<()> {
    let read = |key| -> rusqlite::Result<Option<String>> {
        transaction
            .query_row(
                "SELECT value FROM index_metadata WHERE key = ?1",
                [key],
                |row| row.get(0),
            )
            .optional()
    };
    let stored_model = read("embedding_model")?;
    let stored_dimension = read("embedding_dimension")?;
    match (stored_model, stored_dimension) {
        (None, None) => {
            let populated: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM files) OR EXISTS(SELECT 1 FROM chunks)
                 OR EXISTS(SELECT 1 FROM windows) OR EXISTS(SELECT 1 FROM window_embeddings)",
                [],
                |row| row.get(0),
            )?;
            ensure!(!populated, "populated index is missing embedding metadata");
            transaction.execute(
                "INSERT INTO index_metadata(key, value)
                 VALUES ('embedding_model', ?1), ('embedding_dimension', ?2)",
                params![model, dimension.to_string()],
            )?;
        }
        (Some(stored_model), Some(stored_dimension)) => {
            let stored_dimension: usize = stored_dimension
                .parse()
                .context("invalid embedding_dimension metadata")?;
            ensure!(
                stored_model == model && stored_dimension == dimension,
                "index embedding metadata does not match {model} with dimension {dimension}"
            );
        }
        _ => anyhow::bail!("index is missing an embedding metadata key"),
    }
    Ok(())
}
