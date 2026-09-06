use std::io::{self, Write};
use std::path::Path;
use std::time::{Duration, Instant};

use anyhow::ensure;

use crate::{embedding, storage};

pub fn run(query: &str, limit: usize) -> anyhow::Result<()> {
    let start = Instant::now();
    run_at(
        Path::new("."),
        query,
        limit,
        embedding::production,
        &mut io::stdout().lock(),
        &|| start.elapsed(),
    )
}

fn run_at(
    root: &Path,
    query: &str,
    limit: usize,
    make_embedder: impl FnOnce() -> anyhow::Result<embedding::Embedder>,
    stdout: &mut dyn Write,
    elapsed: &dyn Fn() -> Duration,
) -> anyhow::Result<()> {
    ensure!(!query.trim().is_empty(), "query must not be blank");
    ensure!(
        (1..=4096).contains(&limit),
        "limit must be between 1 and 4096"
    );

    let mut connection = storage::open_read_only(&root.join(".mimirs/index.db"))?;
    // Keep metadata, the empty check, and retrieval in one read snapshot.
    let transaction = connection.transaction()?;
    storage::validate_model(&transaction)?;
    let document_policy = storage::policy::read(&transaction)?;
    let results = if storage::has_content(&transaction)? {
        let mut embedder = make_embedder()?;
        if let Some(policy) = &document_policy {
            ensure!(
                storage::policy::document_policy(&embedder.token_budget()?) == *policy,
                "query tokenizer does not match indexed document policy; run mimirs index"
            );
        }
        let vector = embedder.embed_query(query)?;
        storage::nearest(&transaction, &vector, limit)?
    } else {
        Vec::new()
    };
    transaction.commit()?;
    write_results(stdout, &results, elapsed())
}

fn write_results(
    stdout: &mut dyn Write,
    results: &[storage::SearchResult],
    elapsed: Duration,
) -> anyhow::Result<()> {
    let count = results.len();
    writeln!(
        stdout,
        "results: {count}\ntime: {:.2} seconds",
        elapsed.as_secs_f64()
    )?;
    for (index, result) in results.iter().enumerate() {
        if index > 0 {
            writeln!(stdout, "\n---")?;
        }
        writeln!(
            stdout,
            "\nresult: {}/{count}\nsimilarity: {:.4}",
            index + 1,
            result.similarity
        )?;
        write!(stdout, "location: {}:{}", result.path, result.line_start)?;
        if result.line_start != result.line_end {
            write!(stdout, "-{}", result.line_end)?;
        }
        let indexed = &result.indexed;
        writeln!(
            stdout,
            "\nsource: indexed snapshot {}",
            indexed.snapshot_hash
        )?;
        writeln!(
            stdout,
            "owner: {}",
            indexed
                .owner
                .map_or_else(|| "file".into(), |id| format!("e{id}"))
        )?;
        if result.omitted_candidates > 0 {
            writeln!(
                stdout,
                "omitted_matching_candidates: {}",
                result.omitted_candidates
            )?;
        }
        for (number, chunk) in result.chunks.iter().enumerate() {
            if result.chunks.len() > 1 {
                writeln!(
                    stdout,
                    "\nchunk: {}/{} part: {} document: {}",
                    number + 1,
                    result.chunks.len(),
                    chunk.part,
                    chunk.ordinal
                )?;
            }
            for evidence in &chunk.spans {
                writeln!(
                    stdout,
                    "evidence: {:?} bytes {}..{} lines {}..{}",
                    evidence.record,
                    evidence.span.start,
                    evidence.span.end,
                    evidence.span.line_start,
                    evidence.span.line_end
                )?;
            }
            writeln!(stdout, "text: {}", chunk.text)?;
        }
    }

    Ok(())
}

#[cfg(test)]
#[path = "../../tests/unit/commands/search.rs"]
mod tests;
