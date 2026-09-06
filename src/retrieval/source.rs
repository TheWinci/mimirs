//! Source text grouped by language-owned declarations or fallback paragraphs.
use super::{
    Evidence, Record,
    split::{Document, TokenBudget},
};
use crate::analysis::{
    Analysis, LineIndex, Span,
    language::{Chunking, DeclarationRules},
};
use anyhow::{Result, ensure};
use std::collections::HashMap;

pub const POLICY: &str = "source-items-paragraphs-2";

#[derive(Debug, serde::Serialize)]
pub struct Chunk {
    pub owner: Option<usize>,
    pub context: String,
    pub text: String,
    pub span: Span,
    pub signature: Option<Span>,
}

/// Containers contribute their own source between child items. Function bodies
/// and other leaves stay whole, including any nested declarations.
pub fn chunks(analysis: &Analysis) -> Result<Vec<Chunk>> {
    chunks_with(
        analysis,
        crate::analysis::language::for_path(&analysis.source.path).chunking,
    )
}

fn chunks_with(analysis: &Analysis, chunking: Chunking) -> Result<Vec<Chunk>> {
    crate::storage::analysis::validate(analysis)?;
    let lines = LineIndex::new(&analysis.source.text);
    let mut chunks = Vec::new();
    let Chunking::Declarations(rules) = chunking else {
        let mut start = 0;
        let mut position = 0;
        for line in analysis.source.text.split_inclusive('\n') {
            if line.trim().is_empty() {
                push(analysis, &lines, None, start, position, None, &mut chunks);
                start = position + line.len();
            }
            position += line.len();
        }
        push(analysis, &lines, None, start, position, None, &mut chunks);
        return Ok(chunks);
    };
    partition(
        analysis,
        &lines,
        &rules,
        None,
        0,
        analysis.source.text.len(),
        &mut chunks,
    )?;
    Ok(chunks)
}

fn partition(
    analysis: &Analysis,
    lines: &LineIndex,
    rules: &DeclarationRules,
    owner: Option<usize>,
    start: usize,
    end: usize,
    output: &mut Vec<Chunk>,
) -> Result<()> {
    let container = owner.is_none_or(|id| {
        rules
            .containers
            .contains(&analysis.entities[id].kind.as_str())
    });
    let mut position = start;
    if container {
        for (id, entity) in analysis.entities.iter().enumerate() {
            if entity.parent != owner {
                continue;
            }
            ensure!(
                entity.span.start >= position && entity.span.end <= end,
                "overlapping source chunk entities"
            );
            // The language identifies facts that attach before a declaration.
            let attached = analysis
                .facts
                .iter()
                .filter(|fact| {
                    fact.owner == Some(id)
                        && rules.leading_facts.contains(&fact.kind.as_str())
                        && fact.span.end <= entity.span.start
                })
                .map(|fact| fact.span.start)
                .min()
                .unwrap_or(entity.span.start);
            let child_start = attached.max(position);
            push(
                analysis,
                lines,
                owner,
                position,
                child_start,
                Some(rules.signature_fact),
                output,
            );
            partition(
                analysis,
                lines,
                rules,
                Some(id),
                child_start,
                entity.span.end,
                output,
            )?;
            position = entity.span.end;
        }
    }
    push(
        analysis,
        lines,
        owner,
        position,
        end,
        Some(rules.signature_fact),
        output,
    );
    Ok(())
}

fn push(
    analysis: &Analysis,
    lines: &LineIndex,
    owner: Option<usize>,
    start: usize,
    end: usize,
    signature_fact: Option<&str>,
    output: &mut Vec<Chunk>,
) {
    let text = &analysis.source.text[start..end];
    if text.trim().is_empty() {
        return;
    }
    let mut parents = Vec::new();
    let mut parent = owner.and_then(|id| analysis.entities[id].parent);
    while let Some(id) = parent {
        let entity = &analysis.entities[id];
        if let Some(name) = &entity.name {
            parents.push(format!("{} {name}", entity.kind));
        }
        parent = entity.parent;
    }
    parents.reverse();
    let mut context = analysis.source.path.clone();
    for parent in parents {
        context.push_str(" :: ");
        context.push_str(&parent);
    }
    let signature = owner.and_then(|id| {
        analysis
            .facts
            .iter()
            .find(|fact| fact.owner == Some(id) && Some(fact.kind.as_str()) == signature_fact)
            .map(|fact| fact.span.clone())
    });
    output.push(Chunk {
        owner,
        context,
        text: text.to_owned(),
        span: lines.span(start, end),
        signature,
    });
}

pub fn documents(analysis: &Analysis, budget: &TokenBudget) -> Result<Vec<Document>> {
    let mut output = Vec::new();
    let mut parts = HashMap::new();
    let lines = LineIndex::new(&analysis.source.text);
    for chunk in chunks(analysis)? {
        // Leave space for source even with unusually long paths or signatures.
        // Only repeated context is shortened; the original source is still split in full.
        let context = bounded(budget, &chunk.context, budget.limit / 4)?;
        let mut prefix = format!("{context}\n");
        let mut signature_evidence = None;
        if budget.count(&format!("{prefix}{}", chunk.text))? > budget.limit
            && let Some(span) = &chunk.signature
        {
            let signature = &analysis.source.text[span.start..span.end];
            let signature = bounded(budget, signature.trim_end(), budget.limit / 4)?;
            prefix.push_str(signature);
            prefix.push('\n');
            signature_evidence = Some(Evidence {
                record: Record::Source,
                span: lines.span(span.start, span.start + signature.len()),
            });
        }
        let mut start = chunk.span.start;
        while start < chunk.span.end {
            let remaining = &analysis.source.text[start..chunk.span.end];
            let end = if budget.count(&format!("{prefix}{remaining}"))? <= budget.limit {
                chunk.span.end
            } else {
                let fits = budget.prefix_end(&prefix, remaining, budget.limit)?;
                // Prefer a complete source line. A single oversized line splits
                // at tokenizer/UTF-8 boundaries, retaining every byte.
                let mut length = remaining[..fits].rfind('\n').map_or(fits, |i| i + 1);
                if budget.count(&format!("{prefix}{}", &remaining[..length]))? > budget.limit {
                    length = fits;
                }
                start + length
            };
            ensure!(end > start, "source splitting made no progress");
            let text = format!("{prefix}{}", &analysis.source.text[start..end]);
            ensure!(
                budget.count(&text)? <= budget.limit,
                "source document exceeds tokenizer limit"
            );
            let part = parts.entry(chunk.owner).or_insert(0);
            let mut evidence = vec![Evidence {
                record: Record::Source,
                span: lines.span(start, end),
            }];
            evidence.extend(signature_evidence.clone());
            output.push(Document {
                owner: chunk.owner,
                part: *part,
                text,
                evidence,
            });
            *part += 1;
            start = end;
        }
    }
    Ok(output)
}

fn bounded<'a>(budget: &TokenBudget, text: &'a str, limit: usize) -> Result<&'a str> {
    let end = if budget.count(text)? <= limit {
        text.len()
    } else {
        budget.prefix_end("", text, limit)?
    };
    Ok(&text[..end])
}

#[cfg(test)]
#[path = "../../tests/unit/source_retrieval.rs"]
mod tests;
