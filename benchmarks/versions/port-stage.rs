//! Opt-in stage probe against a copy of the frozen q8 index. No reindexing or
//! source construction changes: isolate candidates from embedding policy.
use crate::storage;
use serde_json::{Value, json};

#[test]
#[ignore = "requires MIMIRS_PORT_BASELINE_DB, MIMIRS_PORT_QUERIES, MIMIRS_PORT_REPORT and cached q8 model"]
fn candidate_stage_report() -> anyhow::Result<()> {
    let baseline = std::env::var("MIMIRS_PORT_BASELINE_DB")?;
    let queries_path = std::env::var("MIMIRS_PORT_QUERIES")?;
    let output = std::env::var("MIMIRS_PORT_REPORT")?;
    let dir = tempfile::tempdir()?;
    let path = dir.path().join("stage.db");
    std::fs::copy(&baseline, &path)?;
    storage::register_vec()?;
    let mut db = rusqlite::Connection::open(path)?;
    db.execute_batch("CREATE VIRTUAL TABLE document_fts USING fts5(path, chunk_name, text, content='', contentless_delete=1, tokenize='unicode61')")?;
    let tx = db.transaction()?;
    {
        let mut stmt = tx.prepare(
            "SELECT d.id, f.path, e.name, s.source, d.evidence FROM retrieval_documents d
            JOIN files f ON f.id=d.file_id JOIN source_snapshots s ON s.file_id=f.id
            LEFT JOIN entities e ON e.file_id=d.file_id AND e.ordinal=d.owner ORDER BY d.id",
        )?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            let source: String = row.get(3)?;
            let evidence: Vec<crate::retrieval::Evidence> =
                serde_json::from_str(&row.get::<_, String>(4)?)?;
            let text = evidence
                .iter()
                .map(|e| &source[e.span.start..e.span.end])
                .collect::<Vec<_>>()
                .join("\n");
            storage::lexical::insert(
                &tx,
                row.get(0)?,
                &row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?.as_deref(),
                &text,
            )?;
        }
    }
    tx.commit()?;
    let queries: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(&queries_path)?)?;
    let mut embedder = crate::embedding::production()?;
    let mut cases = Vec::new();
    for (index, query) in queries.iter().enumerate() {
        let vector = embedder.embed_query(query["query"].as_str().unwrap())?;
        let mut result =
            storage::candidates::read(&db, query["query"].as_str().unwrap(), Some(&vector))?;
        result.candidates.sort_by(|a, b| {
            b.score()
                .total_cmp(&a.score())
                .then_with(|| {
                    b.semantic_score
                        .unwrap_or(0.0)
                        .total_cmp(&a.semantic_score.unwrap_or(0.0))
                })
                .then_with(|| a.compare_position(b))
        });
        let mut seen = std::collections::HashSet::new();
        let paths: Vec<_> = result
            .candidates
            .iter()
            .filter(|c| seen.insert(c.path.as_str()))
            .map(|c| c.path.clone())
            .take(20)
            .collect();
        cases.push(json!({"index":index, "query":query["query"], "expected":query["expected"], "paths":paths,
            "query_vector":vector, "initial_semantic":result.baseline_semantic, "initial_lexical":result.baseline_lexical,
            "candidates":result.candidates.iter().map(|c| json!({"id":c.id,"path":c.path,"ordinal":c.ordinal,
                "semantic_score":c.semantic_score,"lexical_score":c.lexical_score,"semantic_rank":c.semantic_rank,"lexical_rank":c.lexical_rank,"score":c.score()})).collect::<Vec<_>>() }));
    }
    let report = json!({"baseline_db":baseline,"queries_sha256":storage::processing::source_hash(&std::fs::read_to_string(&queries_path)?),
        "queries":queries_path,"model":crate::embedding::model_identity(),
        "stage":"completed window fusion with first occurrence per file; no grouping/signals or new semantic inputs",
        "cases":cases});
    let file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(output)?;
    serde_json::to_writer_pretty(file, &report)?;
    Ok(())
}
