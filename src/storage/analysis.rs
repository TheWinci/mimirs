use crate::{
    analysis::{Analysis, Entity, Span},
    source::SourceFile,
};
use anyhow::{Context, Result, ensure};
use rusqlite::{Connection, OptionalExtension, Transaction, params};

pub const ANALYSIS_VERSION: &str = "rust-0.24.2/extractor-1";

pub fn validate_span(source: &str, span: &Span) -> Result<()> {
    ensure!(
        source.get(span.start..span.end).is_some(),
        "invalid source span {}..{}",
        span.start,
        span.end
    );
    ensure!(
        *span == Span::at(source, span.start, span.end),
        "invalid source line range"
    );
    Ok(())
}

pub fn validate_entities(source: &str, entities: &[Entity]) -> Result<()> {
    for (id, entity) in entities.iter().enumerate() {
        validate_span(source, &entity.span)?;
        if id > 0 {
            ensure!(
                entities[id - 1].span.start <= entity.span.start,
                "entities are out of source order"
            );
        }
        if let Some(parent) = entity.parent {
            ensure!(parent < id, "invalid entity parent");
            let p = &entities[parent].span;
            ensure!(
                p.start <= entity.span.start && p.end >= entity.span.end,
                "entity escapes its parent"
            );
        }
    }
    Ok(())
}

pub fn write(transaction: &Transaction<'_>, file_id: i64, analysis: &Analysis) -> Result<()> {
    validate_entities(&analysis.source.text, &analysis.entities)?;
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
        params![file_id, ANALYSIS_VERSION, analysis.source.text],
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
    Ok(())
}

pub fn load_entities(
    connection: &Connection,
    path: &str,
) -> Result<Option<(SourceFile, Vec<Entity>)>> {
    let row = connection.query_row("SELECT s.file_id, s.analysis_version, s.source FROM source_snapshots s JOIN files f ON f.id = s.file_id WHERE f.path = ?1", [path], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))).optional()?;
    let Some((file_id, version, text)) = row else {
        return Ok(None);
    };
    ensure!(
        version == ANALYSIS_VERSION,
        "unsupported stored analysis version {version}"
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

#[cfg(test)]
#[path = "../../tests/unit/storage_analysis.rs"]
mod tests;
