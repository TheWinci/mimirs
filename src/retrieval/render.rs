use super::{Projection, Record, RelationKind, Target};
use crate::analysis::Span;

pub const RENDER_VERSION: &str = "evidence-clauses-1";

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Evidence {
    pub record: Record,
    pub span: Span,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Clause {
    pub text: String,
    pub evidence: Vec<Evidence>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Description {
    pub owner: Option<usize>,
    pub identity: Clause,
    pub facts: Vec<Clause>,
}

pub fn render(projection: &Projection<'_>) -> Vec<Description> {
    let analysis = projection.analysis;
    let source = &analysis.source.text;
    let mut output = Vec::new();
    for owner in std::iter::once(None).chain((0..analysis.entities.len()).map(Some)) {
        let mut evidence = Vec::new();
        let mut names = Vec::new();
        let mut ancestor = owner;
        while let Some(id) = ancestor {
            let entity = &analysis.entities[id];
            names.push(format!(
                "{} {}",
                entity.kind,
                entity.name.as_deref().unwrap_or("<anonymous>")
            ));
            evidence.push(Evidence {
                record: Record::Entity(id),
                span: entity.span.clone(),
            });
            ancestor = entity.parent;
        }
        if owner.is_none() {
            evidence.push(Evidence {
                record: Record::File,
                span: analysis.scopes[0].span.clone(),
            });
        }
        let identity = Clause {
            text: if names.is_empty() {
                format!("Rust file {}.", analysis.source.path)
            } else {
                format!(
                    "Rust {} in file {}.",
                    names.join(" in "),
                    analysis.source.path
                )
            },
            evidence,
        };
        let mut clauses = Vec::new();
        for relation in &projection.relations {
            if relation.kind != RelationKind::OwnedBy
                || relation.target != Target::Local(owner.map_or(Record::File, Record::Entity))
            {
                continue;
            }
            let Record::Fact(id) = relation.from else {
                continue;
            };
            let fact = &analysis.facts[id];
            let written = source[fact.span.start..fact.span.end].trim();
            let text = match fact.kind.as_str() {
                "doc" => format!("Documentation: {written}"),
                "comment" => format!("Comment: {written}"),
                "signature" => format!("Written signature: {written}"),
                "attribute" => format!("Written attribute: {written}"),
                "import" | "extern_crate" => {
                    format!("Written import: {written} Target unresolved.")
                }
                "import_member" => continue, // Already represented by the full import; provenance below includes members.
                "call" => {
                    // Closure/block arguments contain bodies. Retain only the callee in that case.
                    if written.contains('{')
                        || fact.evidence.iter().any(|e| {
                            e.role == "argument" && {
                                let text = source[e.span.start..e.span.end].trim();
                                text.starts_with('|')
                                    || text.starts_with("move |")
                                    || text.starts_with("async |")
                            }
                        })
                    {
                        let Some(callee) = fact.evidence.iter().find(|e| e.role == "callee") else {
                            continue;
                        };
                        format!(
                            "Calls written callee {}. Target unresolved.",
                            &source[callee.span.start..callee.span.end]
                        )
                    } else {
                        format!("Calls written expression {written}. Target unresolved.")
                    }
                }
                "binding" => format!("Binding candidate: {written}."),
                "value_reference" | "type_reference" | "field_reference" => format!(
                    "Written {}: {written}. Target unresolved.",
                    fact.kind.replace('_', " ")
                ),
                "macro_invocation" => {
                    let Some(path) = fact.evidence.iter().find(|e| e.role == "path") else {
                        continue;
                    };
                    format!(
                        "Invokes written macro {}. Expansion unknown.",
                        &source[path.span.start..path.span.end]
                    )
                }
                _ => continue,
            };
            let mut evidence = vec![Evidence {
                record: Record::Fact(id),
                span: fact.span.clone(),
            }];
            evidence.extend(fact.evidence.iter().map(|e| Evidence {
                record: Record::Fact(id),
                span: e.span.clone(),
            }));
            if fact.kind == "import" {
                evidence.extend(
                    analysis
                        .facts
                        .iter()
                        .enumerate()
                        .filter(|(_, f)| f.related == Some(id))
                        .map(|(member, f)| Evidence {
                            record: Record::Fact(member),
                            span: f.span.clone(),
                        }),
                );
            }
            clauses.push(Clause { text, evidence });
        }
        for (id, diagnostic) in analysis.diagnostics.iter().enumerate() {
            let span = owner.map_or(&analysis.scopes[0].span, |id| &analysis.entities[id].span);
            if span.start <= diagnostic.span.end && span.end >= diagnostic.span.start {
                clauses.push(Clause {
                    text: format!("Incomplete syntax: {}.", diagnostic.kind),
                    evidence: vec![Evidence {
                        record: Record::Diagnostic(id),
                        span: diagnostic.span.clone(),
                    }],
                });
            }
        }
        if owner.is_some() || !clauses.is_empty() {
            output.push(Description {
                owner,
                identity,
                facts: clauses,
            });
        }
    }
    output
}
