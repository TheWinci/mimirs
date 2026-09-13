//! A set reducer. Event IDs sort output, never decide which assertion wins.
use super::model::*;
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Attachment {
    pub id: EventId,
    pub evidence: FileEvidence,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Verification {
    pub event: EventId,
    pub actor: Actor,
    pub revision: Revision,
    pub evidence: BTreeSet<EventId>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Replacement {
    pub event: EventId,
    pub knowledge: KnowledgeId,
    pub revision: Revision,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewRecord {
    pub event: EventId,
    pub actor: Actor,
    pub review: Review,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Knowledge {
    pub claim: Claim,
    pub origin: Actor,
    pub created_event: EventId,
    pub evidence: Vec<Attachment>,
    pub verifications: Vec<Verification>,
    pub replacements: Vec<Replacement>,
    pub reviews: Vec<ReviewRecord>,
}

pub fn union(
    repository: &RepositoryId,
    events: impl IntoIterator<Item = Event>,
) -> Result<BTreeMap<EventId, Event>> {
    let mut unique = BTreeMap::new();
    for event in events {
        event.validate(repository)?;
        if let Some(previous) = unique.insert(event.id, event.clone()) {
            ensure!(
                previous == event,
                "event ID collision: {} has different content",
                event.id.0
            );
        }
    }
    Ok(unique)
}

pub fn reduce(events: &BTreeMap<EventId, Event>) -> Result<BTreeMap<KnowledgeId, Knowledge>> {
    let mut claims = BTreeMap::new();
    for event in events.values() {
        if let KnowledgeEvent::Created { claim } = &event.payload {
            ensure!(
                !claims.contains_key(&claim.id),
                "knowledge ID collision: {}",
                claim.id.0
            );
            claims.insert(
                claim.id,
                Knowledge {
                    claim: claim.clone(),
                    origin: event.actor.clone(),
                    created_event: event.id,
                    evidence: vec![],
                    verifications: vec![],
                    replacements: vec![],
                    reviews: vec![],
                },
            );
        }
    }
    for event in events.values() {
        if let KnowledgeEvent::EvidenceAttached {
            knowledge,
            evidence,
        } = &event.payload
        {
            let claim = claims.get_mut(knowledge).ok_or_else(|| {
                anyhow::anyhow!("attachment references unknown knowledge {}", knowledge.0)
            })?;
            claim.evidence.push(Attachment {
                id: event.id,
                evidence: evidence.clone(),
            });
        }
    }
    for event in events.values() {
        match &event.payload {
            KnowledgeEvent::Reviewed { review } => {
                let claim = claims
                    .get_mut(&review.knowledge)
                    .ok_or_else(|| anyhow::anyhow!("review references unknown knowledge"))?;
                claim.reviews.push(ReviewRecord {
                    event: event.id,
                    actor: event.actor.clone(),
                    review: review.clone(),
                });
            }
            KnowledgeEvent::Verified {
                knowledge,
                revision,
                evidence,
            } => {
                let claim = claims
                    .get_mut(knowledge)
                    .ok_or_else(|| anyhow::anyhow!("verification references unknown knowledge"))?;
                let attached: BTreeSet<_> = claim.evidence.iter().map(|e| e.id).collect();
                ensure!(
                    evidence.is_subset(&attached),
                    "verification references unattached evidence"
                );
                claim.verifications.push(Verification {
                    event: event.id,
                    actor: event.actor.clone(),
                    revision: revision.clone(),
                    evidence: evidence.clone(),
                });
            }
            KnowledgeEvent::Superseded { old, new, revision } => {
                ensure!(
                    claims.contains_key(new),
                    "replacement references unknown knowledge"
                );
                let claim = claims
                    .get_mut(old)
                    .ok_or_else(|| anyhow::anyhow!("supersession references unknown knowledge"))?;
                claim.replacements.push(Replacement {
                    event: event.id,
                    knowledge: *new,
                    revision: revision.clone(),
                });
            }
            _ => {}
        }
    }
    for claim in claims.values() {
        super::reviews::states(claim)?;
    }
    Ok(claims)
}
