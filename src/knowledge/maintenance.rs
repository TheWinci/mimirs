//! Explicit convenience writes, guarded against stale observations and journal heads.
use super::*;
use crate::knowledge::assessment::maintenance::{self, Reference};

pub struct ReplacementRequest<'a> {
    pub assessment: &'a Reference,
    pub statement: &'a str,
    pub rationale: Option<String>,
    pub kind: Option<KnowledgeKind>,
    pub paths: Option<&'a [String]>,
    pub support: Option<&'a [evidence::Spec]>,
}

fn selected_support(
    reference: &Reference,
    selection: Option<&[evidence::Spec]>,
) -> Result<Vec<evidence::Spec>> {
    let default = if reference.version == 2 {
        reference.support.clone()
    } else {
        reference
            .support_paths
            .iter()
            .map(|p| evidence::Spec::file(p))
            .collect()
    };
    let mut support = selection.unwrap_or(&default).to_vec();
    for spec in &mut support {
        if spec.selector.is_some() && spec.provider.is_none() {
            spec.provider = Some(evidence::provider(&spec.path));
        }
        let observation = reference.observed.get(&spec.path).ok_or_else(|| {
            anyhow::anyhow!("evidence was not inspected; refresh maintenance detail")
        })?;
        ensure!(
            observation.problem.is_none() && observation.sha256.is_some(),
            "evidence unavailable; inspect or explicitly change complete support"
        );
        ensure!(
            if reference.version == 2 {
                reference.inspected.contains(spec)
            } else {
                spec.selector.is_none()
            },
            "selector was not inspected; refresh maintenance detail with --anchor"
        );
    }
    support.sort();
    support.dedup();
    ensure!(
        !support.is_empty(),
        "complete nonempty evidence is required"
    );
    Ok(support)
}

fn written_support_matches(reference: &Reference, events: &[Event]) -> Result<()> {
    for event in events {
        let evidence: Vec<_> = match &event.payload {
            KnowledgeEvent::Reviewed { review } => review.evidence.iter().collect(),
            KnowledgeEvent::EvidenceAttached { evidence, .. } => vec![evidence],
            _ => vec![],
        };
        for support in evidence {
            ensure!(
                reference
                    .observed
                    .get(&support.path)
                    .and_then(|o| o.sha256.as_ref())
                    == Some(&support.sha256),
                "stale assessment: evidence changed during publication preparation"
            );
        }
    }
    Ok(())
}

impl Store {
    pub fn review_assessed(
        &mut self,
        checkout: &checkout::Checkout,
        actor: &Actor,
        reference: &Reference,
        paths: Option<&[String]>,
        promote: bool,
    ) -> Result<EventId> {
        let selection = paths.map(|p| {
            p.iter()
                .map(|p| evidence::Spec::file(p))
                .collect::<Vec<_>>()
        });
        self.review_assessed_with_evidence(
            checkout,
            actor,
            reference,
            selection.as_deref(),
            promote,
        )
    }
    pub fn review_assessed_with_evidence(
        &mut self,
        checkout: &checkout::Checkout,
        actor: &Actor,
        reference: &Reference,
        selection: Option<&[evidence::Spec]>,
        promote: bool,
    ) -> Result<EventId> {
        let (_, id) = self.journal.append_checked(|events| {
            let current = maintenance::validate_reference(checkout, events, reference)?;
            ensure!(
                !current.item.relationship_conflict,
                "unresolved replacement relationship conflict"
            );
            let support = selected_support(reference, selection)?;
            let event = review_event_typed(
                &self.repository,
                checkout,
                actor,
                &current.claims,
                ReviewRequest {
                    knowledge: reference.knowledge,
                    replaces: reference.review_heads.clone(),
                    paths: &[],
                    promote,
                },
                Some(&support),
            )?;
            written_support_matches(reference, std::slice::from_ref(&event))?;
            maintenance::ensure_observations(checkout, reference)?;
            let id = event.id;
            Ok((vec![event], id))
        })?;
        self.replay()?;
        Ok(id)
    }

    pub fn replace_assessed(
        &mut self,
        checkout: &checkout::Checkout,
        actor: &Actor,
        request: ReplacementRequest<'_>,
    ) -> Result<KnowledgeId> {
        let reference = request.assessment;
        let (_,id)=self.journal.append_checked(|events| {
            let current=maintenance::validate_reference(checkout,events,reference)?;
            let old=&current.claims[&reference.knowledge];
            ensure!(request.statement.trim()!=old.claim.statement.trim(),"use review-assessed for an unchanged statement");
            ensure!(!current.item.relationship_conflict && current.item.applicable_replacements.is_empty(),
                "claim already has an applicable replacement or relationship conflict; inspect its successor");
            ensure!(checkout.branch.as_deref()==Some(checkout.default_branch.as_str()) && !checkout.dirty()?,
                "assessed replacement requires a clean checkout on the configured default branch");
            ensure!(checkout.contains(&old.claim.learned_at)? && !current.item.review_heads.is_empty() && current.item.invalid_reviews.is_empty(),
                "replacement requires applicable, available supporting review history");
            let legacy=request.paths.map(|p|p.iter().map(|p|evidence::Spec::file(p)).collect::<Vec<_>>());
            let support=selected_support(reference,request.support.or(legacy.as_deref()))?;
            let (id,mut batch)=learning_events_typed(&self.repository,checkout,actor,
                request.kind.unwrap_or_else(||old.claim.kind.clone()),request.statement,request.rationale,&support)?;
            for event in &batch {
                if let KnowledgeEvent::Created {claim}=&event.payload {
                    ensure!(!claim.provisional,"replacement support must be committed on the default branch");
                }
            }
            batch.push(Event::new(&self.repository,actor,KnowledgeEvent::Superseded {
                old:reference.knowledge,new:id,revision:checkout.revision.clone(),
            })?);
            written_support_matches(reference,&batch)?;
            maintenance::ensure_observations(checkout,reference)?;
            // One segment publishes the new claim, all support, verification and relationship.
            Ok((batch,id))
        })?;
        self.replay()?;
        Ok(id)
    }
}
