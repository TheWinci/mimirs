//! Bounded lexical selection before live evidence reads.
use super::*;
use anyhow::ensure;
use serde_json::{Value, json};

pub const DEFAULT_LIMIT: usize = 5;

pub fn validate(query: &str, limit: usize) -> Result<()> {
    ensure!(!query.trim().is_empty(), "query must not be blank");
    ensure!(
        query.len() <= 4096,
        "query must not exceed 4096 UTF-8 bytes"
    );
    ensure!(
        (1..=20).contains(&limit),
        "knowledge limit must be between 1 and 20"
    );
    Ok(())
}

fn tokens(text: &str) -> BTreeSet<String> {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|s| !s.is_empty())
        .map(str::to_lowercase)
        .collect()
}

#[derive(Debug, Serialize)]
struct Candidate {
    id: KnowledgeId,
    score: usize,
    lexical_score: usize,
    source_paths: Vec<String>,
    scope: BTreeSet<String>,
}

pub struct Selection {
    pub summary: Value,
    pub items: Vec<Value>,
}

/// The reader can share observations with retrieved source files in the same request.
pub fn select<R: Into<Observed>>(
    checkout: &Checkout,
    events: &BTreeMap<EventId, Event>,
    query: &str,
    source_paths: &BTreeSet<String>,
    limit: usize,
    read: impl FnMut(&str) -> Result<R>,
) -> Result<Selection> {
    validate(query, limit)?;
    let claims = crate::knowledge::projection::reduce(events)?;
    let graph = Graph::new(checkout, &claims)?;
    let terms = tokens(query);
    let mut candidates = Vec::new();
    for (id, k) in &claims {
        if graph.replacements[id].len() == 1 && !graph.conflicts.contains(id) {
            continue;
        }
        let mut scope: BTreeSet<_> = graph.active[id]
            .heads
            .iter()
            .flat_map(|h| h.evidence.iter().map(|e| e.evidence.path.clone()))
            .collect();
        if scope.is_empty() {
            scope.extend(k.claim.scope.iter().cloned());
        }
        let lexical_score = 4 * terms.intersection(&tokens(&k.claim.statement)).count()
            + 2 * terms
                .intersection(&tokens(k.claim.rationale.as_deref().unwrap_or("")))
                .count()
            + terms
                .intersection(&tokens(
                    &scope.iter().cloned().collect::<Vec<_>>().join(" "),
                ))
                .count();
        let shared: Vec<_> = source_paths.intersection(&scope).cloned().collect();
        let score = lexical_score + 3 * shared.len().min(3);
        if score > 0 {
            candidates.push(Candidate {
                id: *id,
                score,
                lexical_score,
                source_paths: shared,
                scope,
            });
        }
    }
    candidates.sort_by(|a, b| b.score.cmp(&a.score).then(a.id.cmp(&b.id)));
    let matched = candidates.len();
    candidates.truncate(limit);
    let selected = candidates.iter().map(|c| c.id).collect();
    let assessment = graph.assess(checkout, &claims, Some(&selected), read)?;
    let mut assessed: BTreeMap<_, _> = assessment
        .items
        .into_iter()
        .map(|i| (i.knowledge.claim.id, i))
        .collect();
    let mut items = Vec::new();
    for candidate in candidates {
        let item = assessed
            .remove(&candidate.id)
            .expect("selected claim assessed");
        let multiple_reviews = item
            .evidence
            .iter()
            .map(|e| e.review)
            .collect::<BTreeSet<_>>()
            .len()
            > 1;
        let evidence: Vec<_> = item
            .evidence
            .iter()
            .map(|e| {
                let mut value = json!({"path":e.path,"comparison":e.comparison});
                if e.problem.is_some() {
                    value["problem"] = json!(e.problem);
                    value["current_sha256"] = json!(e.current_sha256);
                }
                if let Some(anchor) = &e.anchor {
                    value["anchor"] = anchor.clone();
                }
                if multiple_reviews {
                    value["review"] = json!(e.review);
                }
                value
            })
            .collect();
        items.push(json!({
            "id":candidate.id,"statement":item.knowledge.claim.statement,"kind":item.knowledge.claim.kind,
            "scope":candidate.scope,"selection":{"score":candidate.score,"lexical_score":candidate.lexical_score,"source_paths":candidate.source_paths},
            "origin":{"actor":item.knowledge.origin,"revision":item.knowledge.claim.learned_at,"event":item.knowledge.created_event},
            "status":item.status,"reason":item.reason,
            "history":if item.review_heads.is_empty(){"unavailable_or_not_ancestor"}else if !item.invalid_reviews.is_empty(){"invalid_review_ancestry"}else{"applicable"},
            "review_heads":item.review_heads,"relationship_conflict":item.relationship_conflict,"invalid_relationships":item.invalid_relationships,"replacements":item.applicable_replacements,
            "evidence":evidence,
            "detail":{"operation":"knowledge maintenance","id":candidate.id}
        }));
    }
    Ok(Selection {
        summary: json!({"status":if claims.is_empty(){"empty"}else if matched==0{"no_match"}else{"ok"},
            "revision":checkout.revision,"dirty":checkout.dirty()?,"claims":claims.len(),"matched":matched,
            "selected":items.len(),"ancestry_checks":graph.ancestry_checks,"evidence_paths":assessment.files_read,"omitted_candidates":matched-items.len(),
            "omitted_items":items.len(),"next_detail":items.first().map(|i|i["id"].clone()),"items":[]}),
        items,
    })
}

#[cfg(test)]
#[path = "../../../tests/unit/context/query.rs"]
mod tests;
