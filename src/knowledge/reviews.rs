//! Explicit review ancestry, independent of event delivery order and wall clocks.
use super::{checkout::Checkout, model::*, projection::Knowledge};
use anyhow::{Result, ensure};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Serialize)]
pub struct Support {
    pub attachment: Option<EventId>,
    pub evidence: FileEvidence,
}
#[derive(Debug, Clone, Serialize)]
pub struct State {
    pub event: EventId,
    pub actor: Actor,
    pub revision: Revision,
    pub replaces: BTreeSet<EventId>,
    pub evidence: Vec<Support>,
    pub verified: bool,
    pub promote: bool,
}

/// Return a topological order based only on references. Missing parents and cycles
/// are protocol errors, while sibling reviews are valid domain conflicts.
pub fn states(knowledge: &Knowledge) -> Result<Vec<State>> {
    let initial = State {
        event: knowledge.created_event,
        actor: knowledge.origin.clone(),
        revision: knowledge.claim.learned_at.clone(),
        replaces: BTreeSet::new(),
        evidence: knowledge
            .evidence
            .iter()
            .map(|a| Support {
                attachment: Some(a.id),
                evidence: a.evidence.clone(),
            })
            .collect(),
        verified: false,
        promote: false,
    };
    let mut pending = BTreeMap::new();
    let all_attachments: BTreeSet<_> = knowledge.evidence.iter().map(|a| a.id).collect();
    for v in &knowledge.verifications {
        pending.insert(
            v.event,
            State {
                event: v.event,
                actor: v.actor.clone(),
                revision: v.revision.clone(),
                replaces: [initial.event].into_iter().collect(),
                // Retain the conservative v1 rule until an explicit complete-set review.
                evidence: initial.evidence.clone(),
                verified: v.evidence == all_attachments,
                promote: false,
            },
        );
    }
    for record in &knowledge.reviews {
        let review = &record.review;
        pending.insert(
            record.event,
            State {
                event: record.event,
                actor: record.actor.clone(),
                revision: review.revision.clone(),
                replaces: review.replaces.clone(),
                evidence: review
                    .evidence
                    .iter()
                    .map(|evidence| Support {
                        attachment: None,
                        evidence: evidence.clone(),
                    })
                    .collect(),
                verified: true,
                promote: review.promote,
            },
        );
    }
    let mut seen = BTreeSet::from([initial.event]);
    let mut ordered = vec![initial];
    while !pending.is_empty() {
        let ready: Vec<_> = pending
            .values()
            .filter(|s| s.replaces.is_subset(&seen))
            .map(|s| s.event)
            .collect();
        ensure!(
            !ready.is_empty(),
            "review references unknown or other-claim states, or contains a cycle"
        );
        for id in ready {
            if let Some(state) = pending.remove(&id) {
                seen.insert(id);
                ordered.push(state);
            }
        }
    }
    Ok(ordered)
}

pub struct Active {
    pub heads: Vec<State>,
    pub promotions: Vec<State>,
    pub invalid: Vec<State>,
    pub invalid_history_count: usize,
}
impl Active {
    pub fn ids(&self) -> BTreeSet<EventId> {
        self.heads.iter().map(|s| s.event).collect()
    }
    pub fn conflicted(&self) -> bool {
        self.heads.len() > 1 || !self.invalid.is_empty()
    }
    pub fn eligible(&self, knowledge: &Knowledge) -> bool {
        !knowledge.claim.provisional || !self.promotions.is_empty()
    }
}

pub fn active(checkout: &Checkout, knowledge: &Knowledge) -> Result<Active> {
    active_with(
        knowledge,
        |revision, descendant| checkout.is_ancestor(revision, descendant),
        &checkout.revision,
    )
}

pub(crate) fn active_with(
    knowledge: &Knowledge,
    mut ancestor: impl FnMut(&Revision, &Revision) -> Result<bool>,
    current: &Revision,
) -> Result<Active> {
    let states = states(knowledge)?;
    let mut applicable: BTreeMap<EventId, State> = BTreeMap::new();
    let mut retired = BTreeSet::new();
    let mut promotions = vec![];
    let mut invalid = vec![];
    let mut invalid_parents = BTreeSet::new();
    for state in states {
        if !ancestor(&state.revision, current)? {
            continue;
        }
        let mut valid = true;
        for parent in &state.replaces {
            if let Some(prior) = applicable.get(parent) {
                valid &= ancestor(&prior.revision, &state.revision)?;
            } else {
                valid = false;
            }
        }
        if !valid {
            invalid_parents.extend(state.replaces.iter().copied());
            invalid.push(state);
            continue;
        }
        retired.extend(state.replaces.iter().copied());
        if state.promote {
            promotions.push(state.clone());
        }
        applicable.insert(state.event, state);
    }
    let heads = applicable
        .into_iter()
        .filter(|(id, _)| !retired.contains(id))
        .map(|(_, state)| state)
        .collect();
    let invalid_history_count = invalid.len();
    invalid.retain(|state| !invalid_parents.contains(&state.event));
    Ok(Active {
        heads,
        promotions,
        invalid,
        invalid_history_count,
    })
}
