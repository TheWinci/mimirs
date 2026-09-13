#[derive(Clone, Copy, clap::ValueEnum)]
pub enum Output {
    Full,
    Compact,
}

use std::io::{self, Write};
use std::path::Path;
use std::time::{Duration, Instant};

use crate::embedding;
#[cfg(test)]
use crate::storage;
use crate::storage::hybrid::{FileResult, Response};
#[cfg(test)]
use anyhow::ensure;

pub fn run(query: &str, limit: usize, output: Output) -> anyhow::Result<()> {
    if matches!(output, Output::Compact) {
        let result = crate::retrieval::query::Retriever::default().retrieve(
            Path::new("."),
            query,
            limit,
            true,
            embedding::production,
        )?;
        let text = result
            .compact
            .unwrap()
            .render(crate::retrieval::compact::MAX_BYTES, &str::len)?;
        io::stdout().lock().write_all(text.as_bytes())?;
        return Ok(());
    }
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
    let result = crate::retrieval::query::Retriever::default().retrieve(
        root,
        query,
        limit,
        false,
        make_embedder,
    )?;
    write_results(stdout, &result.results, elapsed())
}

fn write_results(
    stdout: &mut dyn Write,
    results: &Response,
    elapsed: Duration,
) -> anyhow::Result<()> {
    let count = results.source.len();
    writeln!(
        stdout,
        "results: {count}\ntime: {:.2} seconds",
        elapsed.as_secs_f64()
    )?;
    for (index, result) in results.source.iter().enumerate() {
        if index > 0 {
            writeln!(stdout, "\n---")?;
        }
        writeln!(stdout, "\nresult: {}/{count}", index + 1)?;
        write_file(stdout, result)?;
    }
    if !results.docs.is_empty() {
        writeln!(stdout, "\ndocumentation: {}", results.docs.len())?;
        for (index, result) in results.docs.iter().enumerate() {
            writeln!(stdout, "\ndocument: {}/{}", index + 1, results.docs.len())?;
            write_file(stdout, result)?;
        }
    }
    for relation in &results.relations {
        writeln!(stdout, "reference: {}", serde_json::to_string(relation)?)?;
    }
    Ok(())
}

fn write_file(stdout: &mut dyn Write, result: &FileResult) -> anyhow::Result<()> {
    let representative = &result.hit.representative;
    let block = result
        .blocks
        .iter()
        .find(|b| b.document.id == representative.id)
        .or_else(|| result.blocks.first())
        .expect("ranked file has source evidence");
    let first = &block
        .evidence
        .first()
        .expect("source block has evidence")
        .span;
    let last = &block.evidence.last().unwrap().span;
    writeln!(stdout, "relevance: {:.6}", result.hit.score)?;
    write!(
        stdout,
        "location: {}:{}",
        representative.path, first.line_start
    )?;
    if first.line_start != last.line_end {
        write!(stdout, "-{}", last.line_end)?;
    }
    writeln!(
        stdout,
        "\nsource: indexed snapshot {}",
        result.snapshot_hash
    )?;
    writeln!(
        stdout,
        "owner: {}",
        representative
            .owner
            .map_or_else(|| "file".into(), |id| format!("e{id}"))
    )?;
    writeln!(
        stdout,
        "preview: {}",
        serde_json::to_string(&result.preview)?
    )?;
    for (number, block) in result.blocks.iter().enumerate() {
        writeln!(
            stdout,
            "\nchunk: {}/{} part: {} document: {}",
            number + 1,
            result.blocks.len(),
            block.part,
            block.document.ordinal
        )?;
        writeln!(
            stdout,
            "chunk_owner: {}",
            block
                .document
                .owner
                .map_or_else(|| "file".into(), |id| format!("e{id}"))
        )?;
        for evidence in &block.evidence {
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
        writeln!(stdout, "text: {}", block.text)?;
    }
    Ok(())
}

#[cfg(test)]
#[path = "../../tests/unit/commands/search.rs"]
mod tests;
