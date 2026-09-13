//! Checkout-relative assessments. Stored verification is never a freshness cache.
use crate::files::preview;
use crate::knowledge::checkout::{Ancestry, Observed};
use crate::knowledge::{
    checkout::Checkout,
    fingerprint,
    model::*,
    projection::Knowledge,
    reviews::{self, State},
};
use anyhow::Result;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};

pub(crate) mod maintenance;
mod output;
pub(crate) mod query;

pub use output::{orient, show};

/// Revision-relative conflict counts without reading supporting source.
pub fn conflict_counts(
    checkout: &Checkout,
    knowledge: &BTreeMap<KnowledgeId, Knowledge>,
) -> Result<serde_json::Value> {
    let graph = Graph::new(checkout, knowledge)?;
    Ok(
        serde_json::json!({"review_conflicts":graph.active.values().filter(|r|r.conflicted()).count(),
        "replacement_conflicts":graph.conflicts.len(),"detail":"knowledge maintenance"}),
    )
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum Status {
    Verified,
    NeedsRevalidation,
    Provisional,
    Superseded,
}
#[derive(Debug, Serialize)]
pub enum Comparison {
    Unchanged,
    Modified,
    Missing,
    Unavailable,
}
#[derive(Debug, Serialize)]
pub struct CurrentEvidence {
    pub review: EventId,
    pub attachment: Option<EventId>,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anchor: Option<serde_json::Value>,
    pub expected_sha256: String,
    pub current_sha256: Option<String>,
    pub problem: Option<String>,
    pub comparison: Comparison,
    pub current_text: Option<String>,
    pub text_truncated: bool,
}
#[derive(Debug, Serialize)]
pub struct KnowledgeOrigin {
    pub claim: Claim,
    pub origin: Actor,
    pub created_event: EventId,
}
#[derive(Debug, Clone, Serialize)]
pub struct RelationshipIssue {
    pub event: EventId,
    pub replacement: KnowledgeId,
    pub ancestry: Ancestry,
    pub applicability: Ancestry,
}

#[derive(Debug, Serialize)]
pub struct Item {
    pub knowledge: KnowledgeOrigin,
    pub status: Status,
    pub reason: String,
    pub verified_at: Vec<Revision>,
    pub evidence: Vec<CurrentEvidence>,
    pub assessed_review: Option<EventId>,
    pub review_heads: BTreeSet<EventId>,
    pub reviews: Vec<State>,
    pub review_conflict: bool,
    pub invalid_reviews: Vec<State>,
    pub invalid_review_history_count: usize,
    pub applicable_explicit_promotion: bool,
    pub promotions: Vec<State>,
    pub applicable_replacements: Vec<KnowledgeId>,
    pub relationship_conflict: bool,
    pub invalid_relationships: Vec<RelationshipIssue>,
}
#[derive(Debug, Serialize)]
pub struct Assessment {
    pub revision: Revision,
    pub files_read: usize,
    pub items: Vec<Item>,
}

fn assess(
    checkout: &Checkout,
    knowledge: &BTreeMap<KnowledgeId, Knowledge>,
    selected: Option<KnowledgeId>,
) -> Result<Assessment> {
    assess_with_reader(checkout, knowledge, selected, |path| {
        Ok(checkout.observe(path))
    })
}

pub(crate) fn assess_with_reader<R: Into<Observed>>(
    checkout: &Checkout,
    knowledge: &BTreeMap<KnowledgeId, Knowledge>,
    selected: Option<KnowledgeId>,
    mut read: impl FnMut(&str) -> Result<R>,
) -> Result<Assessment> {
    let graph = Graph::new(checkout, knowledge)?;
    let selected = selected.map(|id| BTreeSet::from([id]));
    graph.assess(checkout, knowledge, selected.as_ref(), &mut read)
}

/// One request-scoped graph. It never reads supporting source.
struct Graph {
    ancestry_checks: usize,
    active: BTreeMap<KnowledgeId, reviews::Active>,
    replacements: BTreeMap<KnowledgeId, BTreeSet<KnowledgeId>>,
    conflicts: BTreeSet<KnowledgeId>,
    invalid_relationships: BTreeMap<KnowledgeId, Vec<RelationshipIssue>>,
}
impl Graph {
    fn new(checkout: &Checkout, knowledge: &BTreeMap<KnowledgeId, Knowledge>) -> Result<Self> {
        let mut ancestry = BTreeMap::new();
        let mut ancestor = |a: &Revision, b: &Revision| -> Result<Ancestry> {
            a.validate(&checkout.revision.repository)?;
            b.validate(&checkout.revision.repository)?;
            let key = (a.commit.clone(), b.commit.clone());
            if let Some(value) = ancestry.get(&key) {
                return Ok(*value);
            }
            let value = checkout.ancestry(a, b)?;
            ancestry.insert(key, value);
            Ok(value)
        };
        let active: BTreeMap<_, _> = knowledge
            .iter()
            .map(|(id, k)| {
                Ok((
                    *id,
                    reviews::active_with(
                        k,
                        |a, b| Ok(ancestor(a, b)? == Ancestry::Ancestor),
                        &checkout.revision,
                    )?,
                ))
            })
            .collect::<Result<_>>()?;
        let mut replacements: BTreeMap<KnowledgeId, BTreeSet<KnowledgeId>> = BTreeMap::new();
        let mut invalid_relationships = BTreeMap::new();
        for (id, k) in knowledge {
            let mut targets = BTreeSet::new();
            let mut issues = Vec::new();
            for r in &k.replacements {
                let applicability = ancestor(&r.revision, &checkout.revision)?;
                if applicability == Ancestry::NotAncestor {
                    continue;
                }
                let new = &knowledge[&r.knowledge];
                let old_cause = ancestor(&k.claim.learned_at, &r.revision)?;
                let new_cause = ancestor(&new.claim.learned_at, &r.revision)?;
                let ancestry = if [old_cause, new_cause].contains(&Ancestry::NotAncestor) {
                    Ancestry::NotAncestor
                } else if [old_cause, new_cause, applicability].contains(&Ancestry::Unavailable) {
                    Ancestry::Unavailable
                } else {
                    Ancestry::Ancestor
                };
                if ancestry != Ancestry::Ancestor {
                    issues.push(RelationshipIssue {
                        event: r.event,
                        replacement: r.knowledge,
                        ancestry,
                        applicability,
                    });
                    continue;
                }
                if active[&r.knowledge].eligible(new) {
                    targets.insert(r.knowledge);
                }
            }
            replacements.insert(*id, targets);
            invalid_relationships.insert(*id, issues);
        }
        let cycle_reachable = reaches_cycles(&replacements);
        let conflicts = replacements
            .iter()
            .filter_map(|(id, targets)| {
                (invalid_relationships[id]
                    .iter()
                    .any(|issue| issue.applicability == Ancestry::Ancestor)
                    || targets.len() > 1
                    || cycle_reachable.contains(id))
                .then_some(*id)
            })
            .collect();
        Ok(Self {
            ancestry_checks: ancestry.len(),
            active,
            replacements,
            conflicts,
            invalid_relationships,
        })
    }
    fn assess<R: Into<Observed>>(
        &self,
        checkout: &Checkout,
        knowledge: &BTreeMap<KnowledgeId, Knowledge>,
        selected: Option<&BTreeSet<KnowledgeId>>,
        mut read: impl FnMut(&str) -> Result<R>,
    ) -> Result<Assessment> {
        let active = &self.active;
        let replacements = &self.replacements;
        let mut current = BTreeMap::new();
        let mut result = Assessment {
            revision: checkout.revision.clone(),
            files_read: 0,
            items: vec![],
        };
        for (id, k) in knowledge {
            if selected.is_some_and(|selected| !selected.contains(id)) {
                continue;
            }
            let reviews = active
                .get(id)
                .ok_or_else(|| anyhow::anyhow!("missing review assessment"))?;
            let fallback;
            let heads = if reviews.heads.is_empty() {
                fallback = reviews::states(k)?.into_iter().take(1).collect::<Vec<_>>();
                &fallback
            } else {
                &reviews.heads
            };
            let mut evidence = vec![];
            let mut unchanged = heads.len() == 1 && !heads[0].evidence.is_empty();
            for head in heads {
                for support in &head.evidence {
                    let path = &support.evidence.path;
                    if !current.contains_key(path) {
                        current.insert(path.clone(), read(path)?.into());
                    }
                    let observed = &current[path];
                    let source = observed.source(path);
                    let source = source.as_ref();
                    let hash = observed.metadata.sha256.clone();
                    let resolved = support.evidence.anchor.as_ref().map(|anchor| {
                        source
                            .ok_or_else(|| anyhow::anyhow!("anchor source unavailable"))
                            .and_then(|source| {
                                crate::knowledge::evidence::resolve(
                                    source,
                                    &anchor.selector,
                                    Some(&anchor.provider),
                                )
                            })
                    });
                    let matches = match &resolved {
                        Some(Ok(r)) => {
                            Some(&r.region_sha256)
                                == support.evidence.anchor.as_ref().map(|a| &a.region_sha256)
                        }
                        Some(Err(_)) => false,
                        None => hash.as_ref() == Some(&support.evidence.sha256),
                    };
                    let anchor = support.evidence.anchor.as_ref().map(|anchor| {
                        let current=resolved.as_ref().unwrap();
                        serde_json::json!({"comparison_basis":"captured_regions","selector":anchor.selector,"provider":anchor.provider,"expected_region_sha256":anchor.region_sha256,
                            "current_provider":crate::knowledge::evidence::provider(path),
                            "current_region_sha256":current.as_ref().ok().map(|r|&r.region_sha256),
                            "problem":current.as_ref().err().map(|e|format!("{e:#}")),
                            "current_regions":current.as_ref().ok().map(|r|r.regions.iter().map(|region|serde_json::json!({"role":region.role,"span":region.span})).collect::<Vec<_>>()),
                            "contract":crate::knowledge::evidence::CONTRACT})
                    });
                    unchanged &= matches;
                    evidence.push(CurrentEvidence {
                        review: head.event,
                        attachment: support.attachment,
                        path: path.clone(),
                        anchor,
                        expected_sha256: support.evidence.sha256.clone(),
                        comparison: if resolved.as_ref().is_some_and(Result::is_err)
                            || observed
                                .metadata
                                .problem
                                .as_deref()
                                .is_some_and(|p| p != "missing")
                        {
                            Comparison::Unavailable
                        } else if matches {
                            Comparison::Unchanged
                        } else if hash.is_some() {
                            Comparison::Modified
                        } else {
                            Comparison::Missing
                        },
                        current_sha256: hash,
                        problem: observed.metadata.problem.clone(),
                        current_text: if let Some(result) = &resolved {
                            result.as_ref().ok().map(|r| {
                                preview(
                                    &r.regions
                                        .iter()
                                        .map(|r| r.text.as_str())
                                        .collect::<Vec<_>>()
                                        .join("\n"),
                                    2048,
                                )
                                .to_owned()
                            })
                        } else {
                            source.map(|s| preview(&s.text, 2048).to_owned())
                        },
                        text_truncated: if let Some(result) = &resolved {
                            result.as_ref().is_ok_and(|r| {
                                r.regions.iter().map(|r| r.text.len() + 1).sum::<usize>() > 2048
                            })
                        } else {
                            source.is_some_and(|s| s.text.len() > 2048)
                        },
                    });
                }
            }
            let selected =
                (reviews.heads.len() == 1 && reviews.invalid.is_empty()).then(|| &reviews.heads[0]);
            let verified_at = selected
                .filter(|r| r.verified)
                .map(|r| vec![r.revision.clone()])
                .unwrap_or_default();
            let targets = replacements.get(id).cloned().unwrap_or_default();
            let relationship_conflict = self.conflicts.contains(id);
            let (status, reason) = if !reviews.invalid.is_empty() {
                (
                    Status::NeedsRevalidation,
                    "applicable review has inconsistent or unavailable parent ancestry; no older verification can substitute",
                )
            } else if reviews.heads.len() > 1 {
                (
                    Status::NeedsRevalidation,
                    "concurrent reviews require an explicit review replacing every current head",
                )
            } else if relationship_conflict {
                (
                    Status::NeedsRevalidation,
                    "conflicting, invalid or unavailable supersession ancestry requires inspection",
                )
            } else if !reviews.eligible(k) {
                (
                    Status::Provisional,
                    "original branch or dirty-tree provenance requires an applicable explicit promotion",
                )
            } else if reviews.heads.is_empty() {
                (
                    Status::NeedsRevalidation,
                    "learned or reviewed revision is not a known ancestor of this checkout",
                )
            } else if !targets.is_empty() {
                (
                    Status::Superseded,
                    "an applicable claim explicitly replaces this claim",
                )
            } else if !unchanged {
                (
                    Status::NeedsRevalidation,
                    "active reviewed support changed, is missing, or no evidence is attached",
                )
            } else if verified_at.is_empty() {
                (
                    Status::NeedsRevalidation,
                    "no applicable actor verification covers the active evidence set",
                )
            } else {
                (
                    Status::Verified,
                    "all active support matches an applicable actor review",
                )
            };
            result.items.push(Item {
                knowledge: KnowledgeOrigin {
                    claim: k.claim.clone(),
                    origin: k.origin.clone(),
                    created_event: k.created_event,
                },
                status,
                reason: reason.into(),
                verified_at,
                evidence,
                assessed_review: selected.map(|r| r.event),
                review_heads: reviews.ids(),
                reviews: reviews.heads.clone(),
                review_conflict: reviews.conflicted(),
                invalid_reviews: reviews.invalid.clone(),
                invalid_review_history_count: reviews.invalid_history_count,
                applicable_explicit_promotion: !reviews.promotions.is_empty(),
                promotions: reviews.promotions.clone(),
                applicable_replacements: targets.into_iter().collect(),
                relationship_conflict,
                invalid_relationships: self.invalid_relationships[id].clone(),
            });
        }
        result.files_read = current.len();
        checkout.ensure_head()?;
        Ok(result)
    }
}

// Repeatedly remove sinks. Every remaining node can reach a cycle, including
// predecessors outside the cycle itself. Each edge is visited a bounded number of times.
fn reaches_cycles(graph: &BTreeMap<KnowledgeId, BTreeSet<KnowledgeId>>) -> BTreeSet<KnowledgeId> {
    let mut remaining = BTreeMap::new();
    let mut parents = BTreeMap::<KnowledgeId, Vec<KnowledgeId>>::new();
    for (node, targets) in graph {
        remaining.insert(*node, targets.len());
        for target in targets {
            parents.entry(*target).or_default().push(*node);
        }
    }
    for target in parents.keys() {
        remaining.entry(*target).or_default();
    }
    let mut sinks = remaining
        .iter()
        .filter(|(_, count)| **count == 0)
        .map(|(id, _)| *id)
        .collect::<Vec<_>>();
    while let Some(sink) = sinks.pop() {
        remaining.remove(&sink);
        for parent in parents.get(&sink).into_iter().flatten() {
            if let Some(count) = remaining.get_mut(parent) {
                *count -= 1;
                if *count == 0 {
                    sinks.push(*parent);
                }
            }
        }
    }
    remaining.into_keys().collect()
}

#[cfg(test)]
#[path = "../../tests/unit/context/graph.rs"]
mod graph_tests;

#[cfg(test)]
#[path = "../../tests/support/context.rs"]
pub(crate) mod test_support;
