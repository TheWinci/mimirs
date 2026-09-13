use serde_json::json;

#[test]
#[ignore = "requires MIMIRS_PORT_BASELINE_DB and MIMIRS_PORT_SOURCE_REPORT; extracts saved benchmark snapshots without inference"]
fn source_stage_report() -> anyhow::Result<()> {
    let baseline = std::env::var("MIMIRS_PORT_BASELINE_DB")?;
    let output = std::env::var("MIMIRS_PORT_SOURCE_REPORT")?;
    crate::storage::register_vec()?;
    let db = rusqlite::Connection::open_with_flags(
        &baseline,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let mut stmt=db.prepare("SELECT f.path,s.source FROM files f JOIN source_snapshots s ON s.file_id=f.id ORDER BY f.path")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    let mut files = Vec::new();
    for row in rows {
        let (path, text) = row?;
        let analysis = crate::analysis::extract(crate::source::SourceFile {
            path: path.clone(),
            text,
        })?;
        let normalized = crate::source::normalized::Source::new(&analysis.source.text);
        let documents = crate::retrieval::ts_v2::documents(&analysis)?;
        let mut windows = Vec::new();
        let offset = |raw| normalized.utf16_offset(normalized.normalized_offset(raw)?);
        for document in documents {
            let chunk = &analysis.source_chunks[document.source_chunk.unwrap()];
            let span = &document.evidence[0].span;
            let text = document.text.split_once('\n').unwrap().1;
            windows.push(json!({"startOffset":offset(span.start)?,"endOffset":offset(span.end)?,
                "startLine":span.line_start,"endLine":span.line_end,"textHash":crate::storage::processing::source_hash(text),
                "sourceChunk":{"kind":chunk.kind,"name":chunk.name,"startOffset":offset(chunk.span.start)?,"endOffset":offset(chunk.span.end)?}}));
        }
        let ordinals: std::collections::HashMap<_, _> = analysis
            .source_chunks
            .iter()
            .enumerate()
            .filter(|(_, c)| c.kind != "gap")
            .enumerate()
            .map(|(ordinal, (id, _))| (id, ordinal))
            .collect();
        let chunks = analysis
            .source_chunks
            .iter()
            .filter(|c| c.kind != "gap")
            .map(|c| {
                Ok(json!([
                    c.kind,
                    c.name,
                    offset(c.span.start)?,
                    offset(c.span.end)?,
                    c.parent.map(|p| ordinals[&p])
                ]))
            })
            .collect::<anyhow::Result<Vec<_>>>()?;
        let tree_hash = crate::storage::processing::source_hash(&serde_json::to_string(&chunks)?);
        files.push(json!({"treeHash":tree_hash,"chunkCount":chunks.len(),"path":path,"sourceHash":crate::storage::processing::source_hash(&normalized.text),"windows":windows}));
    }
    let file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(output)?;
    serde_json::to_writer_pretty(file, &json!({"baseline_db":baseline,"files":files}))?;
    Ok(())
}
