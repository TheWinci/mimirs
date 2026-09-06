use super::processing::source_hash;
use crate::{
    analysis::Analysis,
    embedding::DIMENSION,
    retrieval::{Record, split::Document},
};
use anyhow::{Context, Result, ensure};
use rusqlite::{Connection, Transaction, params};

pub struct Batch<'a> {
    pub documents: &'a [Document],
    pub vectors: &'a [Vec<f32>],
    pub policy: &'a str,
}

pub fn save(connection: &mut Connection, analysis: &Analysis, batch: Batch<'_>) -> Result<()> {
    validate(analysis, batch.documents)?;
    super::policy::validate(batch.policy)?;
    let tx = connection.transaction()?;
    if !super::validate_model(&tx)? {
        tx.execute("INSERT INTO index_metadata VALUES ('embedding_model', ?1), ('embedding_dimension', ?2)", params![crate::embedding::model_identity(), DIMENSION.to_string()])?;
    }
    let stored = super::metadata(&tx, "document_policy")?;
    ensure!(
        stored
            .as_deref()
            .is_none_or(|policy| policy == batch.policy),
        "mixed document policies"
    );
    tx.execute(
        "INSERT INTO index_metadata VALUES ('document_policy', ?1) ON CONFLICT(key) DO NOTHING",
        [batch.policy],
    )?;
    tx.execute(
        "INSERT INTO files(path) VALUES (?1) ON CONFLICT(path) DO NOTHING",
        [&analysis.source.path],
    )?;
    let file_id: i64 = tx.query_row(
        "SELECT id FROM files WHERE path=?1",
        [&analysis.source.path],
        |r| r.get(0),
    )?;
    super::delete_file_embeddings(&tx, file_id)?;
    super::analysis::write(&tx, file_id, analysis)?;
    write(&tx, file_id, analysis, batch)?;
    tx.commit()?;
    Ok(())
}

pub fn validate(analysis: &Analysis, documents: &[Document]) -> Result<()> {
    super::analysis::validate(analysis)?;
    let mut parts = std::collections::HashMap::new();
    let lines = crate::analysis::LineIndex::new(&analysis.source.text);
    for document in documents {
        ensure!(
            document.owner.is_none_or(|id| id < analysis.entities.len()),
            "invalid document owner"
        );
        let next = parts.entry(document.owner).or_insert(0);
        ensure!(document.part == *next, "invalid document part order");
        *next += 1;
        ensure!(
            !document.text.is_empty() && !document.evidence.is_empty(),
            "empty document or provenance"
        );
        for evidence in &document.evidence {
            let span = &evidence.span;
            ensure!(
                analysis.source.text.get(span.start..span.end).is_some(),
                "invalid evidence UTF-8 span"
            );
            ensure!(
                *span == lines.span(span.start, span.end),
                "invalid evidence line span"
            );
            let valid = match evidence.record {
                Record::Source => true, // UTF-8 bounds and source line spans were checked above.
                Record::File => *span == analysis.scopes[0].span,
                Record::Entity(id) => analysis.entities.get(id).is_some_and(|e| e.span == *span),
                Record::Fact(id) => analysis
                    .facts
                    .get(id)
                    .is_some_and(|f| f.span == *span || f.evidence.iter().any(|e| e.span == *span)),
                Record::Scope(id) => analysis.scopes.get(id).is_some_and(|s| s.span == *span),
                Record::Diagnostic(id) => analysis
                    .diagnostics
                    .get(id)
                    .is_some_and(|d| d.span == *span),
            };
            ensure!(valid, "evidence does not reference a snapshot record");
        }
    }
    Ok(())
}

pub(super) fn write(
    tx: &Transaction<'_>,
    file_id: i64,
    analysis: &Analysis,
    batch: Batch<'_>,
) -> Result<()> {
    validate(analysis, batch.documents)?;
    ensure!(!batch.policy.is_empty(), "empty document policy");
    ensure!(
        batch.documents.len() == batch.vectors.len(),
        "document/vector count mismatch"
    );
    for (ordinal, (document, vector)) in batch.documents.iter().zip(batch.vectors).enumerate() {
        ensure!(
            vector.len() == DIMENSION && vector.iter().all(|v| v.is_finite()),
            "invalid document vector"
        );
        tx.execute("INSERT INTO retrieval_documents(file_id, ordinal, owner, kind, part, policy, text, content_hash, evidence) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)", params![file_id, ordinal as i64, document.owner.map(|id| id as i64), if document.owner.is_some() { "entity" } else { "file" }, document.part as i64, batch.policy, document.text, source_hash(&document.text), serde_json::to_string(&document.evidence)?])?;
        let id = tx.last_insert_rowid();
        let source = document
            .evidence
            .iter()
            .map(|evidence| &analysis.source.text[evidence.span.start..evidence.span.end])
            .collect::<Vec<_>>()
            .join("\n");
        super::lexical::insert(
            tx,
            id,
            &analysis.source.path,
            document
                .owner
                .and_then(|owner| analysis.entities[owner].name.as_deref()),
            &source,
        )?;
        tx.execute(
            "INSERT INTO document_embeddings(document_id, embedding) VALUES (?1, ?2)",
            params![id, super::vector_bytes(vector)],
        )?;
    }
    tx.execute(
        "INSERT INTO retrieval_processing VALUES (?1, ?2, ?3)",
        params![file_id, batch.policy, batch.documents.len() as i64],
    )?;
    Ok(())
}

pub fn load(connection: &Connection, path: &str, policy: &str) -> Result<Vec<Document>> {
    let analysis = super::analysis::load(connection, path)?.context("missing document snapshot")?;
    let (count, stored): (i64, String) = connection.query_row("SELECT p.document_count, p.policy FROM retrieval_processing p JOIN files f ON f.id=p.file_id WHERE f.path=?1", [path], |r| Ok((r.get(0)?, r.get(1)?)))?;
    ensure!(stored == policy, "unsupported document policy");
    let mut statement = connection.prepare("SELECT d.ordinal, d.owner, d.part, d.text, d.content_hash, d.evidence, d.policy, d.kind, EXISTS(SELECT 1 FROM document_embeddings e WHERE e.document_id=d.id) FROM retrieval_documents d JOIN files f ON f.id=d.file_id WHERE f.path=?1 ORDER BY d.ordinal")?;
    let mut rows = statement.query([path])?;
    let mut documents = Vec::new();
    while let Some(row) = rows.next()? {
        ensure!(
            usize::try_from(row.get::<_, i64>(0)?)? == documents.len(),
            "missing document ordinal"
        );
        let document = Document {
            owner: row
                .get::<_, Option<i64>>(1)?
                .map(usize::try_from)
                .transpose()?,
            part: usize::try_from(row.get::<_, i64>(2)?)?,
            text: row.get(3)?,
            evidence: serde_json::from_str(&row.get::<_, String>(5)?)?,
        };
        ensure!(
            row.get::<_, String>(4)? == source_hash(&document.text),
            "document hash mismatch"
        );
        ensure!(
            row.get::<_, String>(6)? == policy,
            "mixed document policies"
        );
        ensure!(
            row.get::<_, String>(7)?
                == if document.owner.is_some() {
                    "entity"
                } else {
                    "file"
                },
            "invalid document kind"
        );
        ensure!(row.get::<_, bool>(8)?, "missing document vector");
        documents.push(document);
    }
    ensure!(
        usize::try_from(count)? == documents.len(),
        "incomplete document set"
    );
    validate(&analysis, &documents)?;
    Ok(documents)
}

#[cfg(test)]
#[path = "../../tests/unit/storage_documents.rs"]
mod tests;
