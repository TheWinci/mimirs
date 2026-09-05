use std::collections::HashMap;

use anyhow::{Context, ensure};
use rusqlite::{Connection, params};

use super::validate_model;

use crate::{chunk::Chunk, embedding::DIMENSION, source::SourceFile, window::Window};

/// Replace a file atomically. Borrowed object identities become database IDs
/// only here; vectors correspond to windows by position.
pub fn save_file(
    connection: &mut Connection,
    source: &SourceFile,
    chunks: &[Chunk<'_>],
    windows: &[Window<'_>],
    vectors: &[Vec<f32>],
) -> anyhow::Result<()> {
    save_file_with_analysis(connection, source, chunks, windows, vectors, None)
}

pub fn save_file_with_analysis(
    connection: &mut Connection,
    source: &SourceFile,
    chunks: &[Chunk<'_>],
    windows: &[Window<'_>],
    vectors: &[Vec<f32>],
    analysis: Option<&crate::analysis::Analysis>,
) -> anyhow::Result<()> {
    replace_file(connection, source, chunks, windows, vectors, analysis, None)
        .with_context(|| format!("cannot save source file {}", source.path))
}

pub(super) fn replace_file(
    connection: &mut Connection,
    source: &SourceFile,
    chunks: &[Chunk<'_>],
    windows: &[Window<'_>],
    vectors: &[Vec<f32>],
    analysis: Option<&crate::analysis::Analysis>,
    documents: Option<super::documents::Batch<'_>>,
) -> anyhow::Result<()> {
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
            vector.len() == DIMENSION,
            "vector {ordinal} has dimension {}, expected {DIMENSION}",
            vector.len()
        );
        ensure!(
            vector.iter().all(|value| value.is_finite()),
            "vector {ordinal} contains a non-finite value"
        );
    }

    if let Some(analysis) = analysis {
        ensure!(
            analysis.source == *source,
            "analysis does not match indexed source"
        );
        super::analysis::validate(analysis)?;
    }
    let transaction = connection.transaction()?;
    if !validate_model(&transaction)? {
        transaction.execute(
            "INSERT INTO index_metadata(key, value)
             VALUES ('embedding_model', ?1), ('embedding_dimension', ?2)",
            params![crate::embedding::model_identity(), DIMENSION.to_string()],
        )?;
    }
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
    super::delete_file_embeddings(&transaction, file_id)?;
    transaction.execute("DELETE FROM chunks WHERE file_id = ?1", [file_id])?;

    transaction.execute("DELETE FROM source_snapshots WHERE file_id = ?1", [file_id])?;
    if let Some(analysis) = analysis {
        super::analysis::write(&transaction, file_id, analysis)?;
    }

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
    super::processing::stamp(
        &transaction,
        file_id,
        source,
        analysis.is_some(),
        chunks.len(),
        windows.len(),
    )?;
    if let Some(batch) = documents {
        super::documents::write(
            &transaction,
            file_id,
            analysis.context("documents require analysis")?,
            batch,
        )?;
    }
    transaction.commit()?;
    Ok(())
}
