use crate::{
    analysis::{Analysis, Entity, Span},
    source::SourceFile,
};
use anyhow::{Context, Result, ensure};
use rusqlite::{Connection, OptionalExtension, Transaction, params};

use crate::analysis::validation::{validate, validate_entities};
pub fn write(transaction: &Transaction<'_>, file_id: i64, analysis: &Analysis) -> Result<()> {
    validate(analysis)?;
    let path: String =
        transaction.query_row("SELECT path FROM files WHERE id = ?1", [file_id], |r| {
            r.get(0)
        })?;
    ensure!(
        path == analysis.source.path,
        "analysis belongs to another file"
    );
    transaction.execute("DELETE FROM source_snapshots WHERE file_id = ?1", [file_id])?;
    transaction.execute(
        "INSERT INTO source_snapshots VALUES (?1, ?2, ?3)",
        params![
            file_id,
            crate::analysis::language::for_path(&analysis.source.path).identity,
            analysis.source.text
        ],
    )?;
    for (id, entity) in analysis.entities.iter().enumerate() {
        transaction.execute(
            "INSERT INTO entities VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                file_id,
                i64::try_from(id)?,
                entity.kind,
                entity.name,
                i64::try_from(entity.span.start)?,
                i64::try_from(entity.span.end)?,
                i64::try_from(entity.span.line_start)?,
                i64::try_from(entity.span.line_end)?,
                entity.parent.map(i64::try_from).transpose()?
            ],
        )?;
    }
    for (id, chunk) in analysis.source_chunks.iter().enumerate() {
        transaction.execute(
            "INSERT INTO source_chunks VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![
                file_id,
                id as i64,
                chunk.kind,
                chunk.name,
                chunk.span.start as i64,
                chunk.span.end as i64,
                chunk.span.line_start as i64,
                chunk.span.line_end as i64,
                chunk.parent.map(|v| v as i64),
                chunk.owner.map(|v| v as i64)
            ],
        )?;
    }
    let payload = serde_json::to_string(&(
        &analysis.facts,
        &analysis.scopes,
        &analysis.diagnostics,
        &analysis.source_facts,
    ))?;
    transaction.execute(
        "INSERT INTO analysis_records VALUES (?1, ?2)",
        params![file_id, payload],
    )?;
    Ok(())
}

pub fn load_entities(
    connection: &Connection,
    path: &str,
) -> Result<Option<(SourceFile, Vec<Entity>)>> {
    let row = connection.query_row("SELECT s.file_id, s.analysis_version, s.source FROM source_snapshots s JOIN files f ON f.id = s.file_id WHERE f.path = ?1", [path], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))).optional()?;
    let Some((file_id, stored_version, text)) = row else {
        return Ok(None);
    };
    ensure!(
        stored_version == crate::analysis::language::for_path(path).identity,
        "unsupported stored analysis version {stored_version}; run mimirs index"
    );
    let mut statement = connection.prepare("SELECT ordinal, kind, name, byte_start, byte_end, line_start, line_end, parent FROM entities WHERE file_id = ?1 ORDER BY ordinal")?;
    let mut rows = statement.query([file_id])?;
    let mut entities = Vec::new();
    while let Some(row) = rows.next()? {
        let number = |column| -> Result<usize> { Ok(usize::try_from(row.get::<_, i64>(column)?)?) };
        let id = number(0)?;
        ensure!(id == entities.len(), "missing entity ordinal");
        entities.push(Entity {
            kind: row.get(1)?,
            name: row.get(2)?,
            span: Span {
                start: number(3)?,
                end: number(4)?,
                line_start: number(5)?,
                line_end: number(6)?,
            },
            parent: row
                .get::<_, Option<i64>>(7)?
                .map(usize::try_from)
                .transpose()?,
        });
    }
    validate_entities(&text, &entities).context("invalid stored entities")?;
    Ok(Some((
        SourceFile {
            path: path.into(),
            text,
        },
        entities,
    )))
}

pub fn load(connection: &Connection, path: &str) -> Result<Option<Analysis>> {
    let Some((source, entities)) = load_entities(connection, path)? else {
        return Ok(None);
    };
    let payload: String = connection.query_row("SELECT r.payload FROM analysis_records r JOIN files f ON f.id = r.file_id WHERE f.path = ?1", [path], |row| row.get(0)).context("missing stored analysis records")?;
    let (facts, scopes, diagnostics, source_facts) =
        serde_json::from_str(&payload).context("invalid stored analysis payload")?;
    let mut stmt=connection.prepare("SELECT c.ordinal,c.kind,c.name,c.byte_start,c.byte_end,c.line_start,c.line_end,c.parent,c.owner FROM source_chunks c JOIN files f ON f.id=c.file_id WHERE f.path=?1 ORDER BY c.ordinal")?;
    let mut rows = stmt.query([path])?;
    let mut source_chunks = Vec::new();
    while let Some(row) = rows.next()? {
        let number = |index| -> Result<usize> { Ok(usize::try_from(row.get::<_, i64>(index)?)?) };
        ensure!(
            number(0)? == source_chunks.len(),
            "missing source chunk ordinal"
        );
        source_chunks.push(crate::retrieval::ts_v2::Chunk {
            kind: row.get(1)?,
            name: row.get(2)?,
            span: Span {
                start: number(3)?,
                end: number(4)?,
                line_start: number(5)?,
                line_end: number(6)?,
            },
            parent: row
                .get::<_, Option<i64>>(7)?
                .map(usize::try_from)
                .transpose()?,
            owner: row
                .get::<_, Option<i64>>(8)?
                .map(usize::try_from)
                .transpose()?,
        });
    }
    let analysis = Analysis {
        source_facts,
        source_chunks,
        source,
        entities,
        facts,
        scopes,
        diagnostics,
    };
    validate(&analysis).context("invalid stored analysis")?;
    Ok(Some(analysis))
}

#[cfg(test)]
#[path = "../../tests/unit/storage_analysis.rs"]
mod tests;
