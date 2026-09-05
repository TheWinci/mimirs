//! Deterministic retrieval inputs derived from a single validated source snapshot.
use crate::analysis::{Analysis, Span};
use anyhow::Result;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum Record {
    /// A byte range in the saved source, including text outside extracted items.
    Source,
    File,
    Entity(usize),
    Fact(usize),
    Scope(usize),
    Diagnostic(usize),
}

#[derive(Debug, PartialEq, Eq)]
pub enum Target {
    Local(Record),
    Written { span: Span, unresolved: bool },
}

#[derive(Debug, PartialEq, Eq)]
pub enum RelationKind {
    ContainedBy,
    OwnedBy,
    InScope,
    Component(String),
    ImportMemberOf,
    CallOccurrence,
    WrittenUse,
    BindingCandidate,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Relation {
    pub from: Record,
    pub kind: RelationKind,
    pub target: Target,
    pub evidence: Span,
}

pub struct Projection<'a> {
    pub analysis: &'a Analysis,
    pub relations: Vec<Relation>,
}

pub fn project(analysis: &Analysis) -> Result<Projection<'_>> {
    crate::storage::analysis::validate(analysis)?;
    let mut relations = Vec::new();
    let mut add = |from, kind, target, span: &Span| {
        relations.push(Relation {
            from,
            kind,
            target,
            evidence: span.clone(),
        });
    };
    for (id, entity) in analysis.entities.iter().enumerate() {
        add(
            Record::Entity(id),
            RelationKind::ContainedBy,
            Target::Local(entity.parent.map_or(Record::File, Record::Entity)),
            &entity.span,
        );
    }
    for (id, scope) in analysis.scopes.iter().enumerate() {
        add(
            Record::Scope(id),
            RelationKind::OwnedBy,
            Target::Local(scope.owner.map_or(Record::File, Record::Entity)),
            &scope.span,
        );
        if let Some(parent) = scope.parent {
            add(
                Record::Scope(id),
                RelationKind::ContainedBy,
                Target::Local(Record::Scope(parent)),
                &scope.span,
            );
        }
    }
    for (id, fact) in analysis.facts.iter().enumerate() {
        add(
            Record::Fact(id),
            RelationKind::OwnedBy,
            Target::Local(fact.owner.map_or(Record::File, Record::Entity)),
            &fact.span,
        );
        add(
            Record::Fact(id),
            RelationKind::InScope,
            Target::Local(Record::Scope(fact.scope)),
            &fact.span,
        );
        if let Some(related) = fact.related {
            add(
                Record::Fact(id),
                RelationKind::ImportMemberOf,
                Target::Local(Record::Fact(related)),
                &fact.span,
            );
        }
        let kind = match fact.kind.as_str() {
            "call" | "macro_invocation" => Some(RelationKind::CallOccurrence),
            "value_reference" | "type_reference" | "field_reference" => {
                Some(RelationKind::WrittenUse)
            }
            "binding" => Some(RelationKind::BindingCandidate),
            _ => None,
        };
        if let Some(kind) = kind {
            add(
                Record::Fact(id),
                kind,
                Target::Written {
                    span: fact.span.clone(),
                    unresolved: true,
                },
                &fact.span,
            );
        }
        for evidence in &fact.evidence {
            add(
                Record::Fact(id),
                RelationKind::Component(evidence.role.clone()),
                Target::Written {
                    span: evidence.span.clone(),
                    unresolved: true,
                },
                &evidence.span,
            );
        }
    }
    Ok(Projection {
        analysis,
        relations,
    })
}

#[cfg(test)]
#[path = "../tests/unit/retrieval.rs"]
mod tests;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Evidence {
    pub record: Record,
    pub span: Span,
}

pub mod split;

pub mod source;
