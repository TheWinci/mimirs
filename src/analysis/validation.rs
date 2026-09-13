use super::{Analysis, Entity, LineIndex, Span};
use anyhow::{Context, Result, ensure};
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
    for fact in &analysis.source_facts {
        validate_span(source, &fact.location.span(), &lines)?;
        for reference in fact.owner.iter().chain(match &fact.kind {
            crate::analysis::source_facts::Kind::Call { target, .. } => target.as_ref(),
            _ => None,
        }) {
            validate_span(source, &reference.location.span(), &lines)?;
            ensure!(
                analysis
                    .source_chunks
                    .iter()
                    .any(|chunk| chunk.kind == reference.kind
                        && chunk.name.as_deref() == Some(&reference.name)
                        && chunk.span == reference.location.span()),
                "source fact references an unknown chunk"
            );
        }
        if let Some(owner) = &fact.owner {
            ensure!(
                owner.location.start_offset <= fact.location.start_offset
                    && owner.location.end_offset >= fact.location.end_offset,
                "source fact escapes its owner"
            );
        }
        if let crate::analysis::source_facts::Kind::Call {
            binding, target, ..
        } = &fact.kind
        {
            ensure!(
                (*binding == crate::analysis::source_facts::Binding::SourceChunk)
                    == target.is_some(),
                "source call target disagrees with binding"
            );
        }
    }
    Ok(())
}
