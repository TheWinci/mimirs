use crate::{
    analysis::{Analysis, Entity, LineIndex, Span},
    source::SourceFile,
};
use anyhow::{Context, Result, ensure};
use rusqlite::{Connection, OptionalExtension, Transaction, params};

fn validate_span(source: &str, span: &Span, lines: &LineIndex) -> Result<()> {
    ensure!(
        source.get(span.start..span.end).is_some(),
        "invalid source span {}..{}",
        span.start,
        span.end
    );
    ensure!(
        *span == lines.span(span.start, span.end),
        "invalid source line range"
    );
    Ok(())
}

pub fn validate_entities(source: &str, entities: &[Entity]) -> Result<()> {
    let lines = LineIndex::new(source);
    for (id, entity) in entities.iter().enumerate() {
        validate_span(source, &entity.span, &lines)?;
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
    let payload =
        serde_json::to_string(&(&analysis.facts, &analysis.scopes, &analysis.diagnostics))?;
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

pub fn validate(analysis: &Analysis) -> Result<()> {
    let source = &analysis.source.text;
    let lines = LineIndex::new(source);
    validate_entities(source, &analysis.entities)?;
    let owner = |id: Option<usize>| -> Result<()> {
        ensure!(
            id.is_none_or(|id| id < analysis.entities.len()),
            "invalid entity owner"
        );
        Ok(())
    };
    for (id, chunk) in analysis.source_chunks.iter().enumerate() {
        validate_span(source, &chunk.span, &lines)?;
        owner(chunk.owner)?;
        if let Some(parent) = chunk.parent {
            ensure!(parent < id, "invalid source chunk parent");
            let span = &analysis.source_chunks[parent].span;
            ensure!(
                span.start <= chunk.span.start && span.end >= chunk.span.end,
                "source chunk escapes parent"
            );
        }
    }
    ensure!(!analysis.scopes.is_empty(), "missing file scope");
    for (id, scope) in analysis.scopes.iter().enumerate() {
        validate_span(source, &scope.span, &lines)?;
        owner(scope.owner)?;
        if id == 0 {
            ensure!(
                scope.kind == "file"
                    && scope.parent.is_none()
                    && scope.owner.is_none()
                    && scope.span.start == 0
                    && scope.span.end == source.len(),
                "invalid file scope"
            );
        } else {
            let parent = scope.parent.context("scope has no parent")?;
            ensure!(parent < id, "invalid scope parent");
            let span = &analysis.scopes[parent].span;
            ensure!(
                span.start <= scope.span.start && span.end >= scope.span.end,
                "scope escapes parent"
            );
        }
    }
    for (id, fact) in analysis.facts.iter().enumerate() {
        validate_span(source, &fact.span, &lines)?;
        owner(fact.owner)?;
        if id > 0 {
            ensure!(
                analysis.facts[id - 1].span.start <= fact.span.start,
                "facts are out of source order"
            );
        }
        let scope = analysis
            .scopes
            .get(fact.scope)
            .context("invalid fact scope")?;
        ensure!(
            scope.span.start <= fact.span.start && scope.span.end >= fact.span.end,
            "fact escapes scope"
        );
        ensure!(
            fact.related
                .is_none_or(|r| r < analysis.facts.len() && r != id),
            "invalid related fact"
        );
        if fact.kind == "import_member" {
            let related = fact.related.context("import member has no declaration")?;
            ensure!(
                analysis.facts[related].kind == "import"
                    && fact
                        .evidence
                        .iter()
                        .any(|e| e.role == "declaration" && e.span == analysis.facts[related].span),
                "invalid import declaration"
            );
        }
        for evidence in &fact.evidence {
            validate_span(source, &evidence.span, &lines)?;
        }
    }
    for diagnostic in &analysis.diagnostics {
        validate_span(source, &diagnostic.span, &lines)?;
        let column = lines.column(diagnostic.span.start);
        ensure!(diagnostic.column == column, "invalid diagnostic column");
    }
    Ok(())
}

pub fn load(connection: &Connection, path: &str) -> Result<Option<Analysis>> {
    let Some((source, entities)) = load_entities(connection, path)? else {
        return Ok(None);
    };
    let payload: String = connection.query_row("SELECT r.payload FROM analysis_records r JOIN files f ON f.id = r.file_id WHERE f.path = ?1", [path], |row| row.get(0)).context("missing stored analysis records")?;
    let (facts, scopes, diagnostics) =
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
