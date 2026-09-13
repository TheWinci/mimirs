//! User-initiated maintenance observations. These reads author no semantic events.
use super::*;
use crate::knowledge::evidence::{self, Selector, Spec};
use anyhow::{Context, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

mod anchors;
mod history;
mod rendering;

pub use rendering::{DetailOptions, View, detail};

const CONTRACT: &str = "This is an observation, not a semantic review or source lock. Matching attached files does not verify unlisted dependencies. Review the complete supporting set before an explicit write.";

pub use crate::knowledge::checkout::Observation;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Reference {
    pub version: u32,
    pub knowledge: KnowledgeId,
    pub revision: Revision,
    pub checkout: std::path::PathBuf,
    pub branch: Option<String>,
    pub default_branch: String,
    pub dirty: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cleanliness_blockers: Vec<String>,
    pub graph_sha256: String,
    pub review_heads: BTreeSet<EventId>,
    pub invalid_reviews: BTreeSet<EventId>,
    pub support_paths: BTreeSet<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub support: Vec<Spec>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub inspected: Vec<Spec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evaluator: Option<String>,
    pub observed: BTreeMap<String, Observation>,
}

pub struct Inspection {
    pub reference: Reference,
    pub item: Item,
    pub claims: BTreeMap<KnowledgeId, Knowledge>,
    pub sources: BTreeMap<String, Option<crate::source::SourceFile>>,
}

fn observe(checkout: &Checkout, path: &str) -> (Observation, Option<Vec<u8>>) {
    let observed = checkout.observe(path);
    (observed.metadata, observed.bytes)
}

fn graph_hash(claims: &BTreeMap<KnowledgeId, Knowledge>, id: KnowledgeId) -> Result<String> {
    let mut seen = BTreeSet::new();
    let mut pending = vec![id];
    while let Some(id) = pending.pop() {
        if !seen.insert(id) {
            continue;
        }
        let claim = claims.get(&id).context("unknown knowledge ID")?;
        pending.extend(claim.replacements.iter().map(|r| r.knowledge));
    }
    Ok(fingerprint(&serde_json::to_vec(
        &seen.iter().map(|id| &claims[id]).collect::<Vec<_>>(),
    )?))
}

pub fn inspect(
    checkout: &Checkout,
    events: &BTreeMap<EventId, Event>,
    id: KnowledgeId,
    additional: &[String],
) -> Result<Inspection> {
    inspect_typed(
        checkout,
        events,
        id,
        &additional.iter().map(|p| Spec::file(p)).collect::<Vec<_>>(),
    )
}
pub fn inspect_typed(
    checkout: &Checkout,
    events: &BTreeMap<EventId, Event>,
    id: KnowledgeId,
    additional: &[Spec],
) -> Result<Inspection> {
    let claims = crate::knowledge::projection::reduce(events)?;
    ensure!(claims.contains_key(&id), "unknown knowledge ID");
    let mut observed = BTreeMap::new();
    let mut sources = BTreeMap::new();
    let assessment = super::assess_with_reader(checkout, &claims, Some(id), |path| {
        let read = checkout.observe(path);
        observed.insert(path.to_owned(), read.metadata.clone());
        sources.insert(path.to_owned(), read.source(path));
        Ok(read)
    })?;
    let item = assessment
        .items
        .into_iter()
        .next()
        .context("missing assessment")?;
    let support_paths = observed.keys().cloned().collect();
    for spec in additional {
        let path = &spec.path;
        validate_path(path)?;
        if !observed.contains_key(path) {
            let (observation, bytes) = observe(checkout, path);
            observed.insert(path.clone(), observation);
            sources.insert(
                path.clone(),
                bytes.and_then(|b| String::from_utf8(b).ok()).map(|text| {
                    crate::source::SourceFile {
                        path: path.clone(),
                        text,
                    }
                }),
            );
        }
    }
    let states = reviews::states(&claims[&id])?;
    let active = if item.review_heads.is_empty() {
        states.iter().take(1).collect::<Vec<_>>()
    } else {
        states
            .iter()
            .filter(|r| item.review_heads.contains(&r.event))
            .collect()
    };
    let support = active
        .iter()
        .flat_map(|r| r.evidence.iter().map(|e| Spec::from_evidence(&e.evidence)))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let inspected = support
        .iter()
        .cloned()
        .chain(additional.iter().cloned().map(|mut spec| {
            if spec.selector.is_some() && spec.provider.is_none() {
                spec.provider = Some(evidence::provider(&spec.path));
            }
            spec
        }))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let typed = inspected.iter().any(|s| s.selector.is_some());
    let (dirty, cleanliness_blockers) = checkout.cleanliness()?;
    let reference = Reference {
        version: if typed { 2 } else { 1 },
        support: if typed { support } else { vec![] },
        inspected: if typed { inspected } else { vec![] },
        evaluator: typed.then(evidence::current_identity),
        knowledge: id,
        revision: checkout.revision.clone(),
        checkout: checkout.root.clone(),
        branch: checkout.branch.clone(),
        default_branch: checkout.default_branch.clone(),
        dirty,
        cleanliness_blockers,
        graph_sha256: graph_hash(&claims, id)?,
        review_heads: item.review_heads.clone(),
        invalid_reviews: item.invalid_reviews.iter().map(|r| r.event).collect(),
        support_paths,
        observed,
    };
    ensure_observations(checkout, &reference)?;
    Ok(Inspection {
        reference,
        item,
        claims,
        sources,
    })
}

pub fn ensure_observations(checkout: &Checkout, reference: &Reference) -> Result<()> {
    ensure!(
        reference.version != 2
            || reference.evaluator.as_deref() == Some(evidence::current_identity().as_str()),
        "stale assessment: anchor evaluator changed; inspect again"
    );
    checkout.ensure_head()?;
    let (dirty, blockers) = checkout.cleanliness()?;
    ensure!(
        checkout.root == reference.checkout
            && checkout.revision == reference.revision
            && checkout.branch == reference.branch
            && checkout.default_branch == reference.default_branch
            && dirty == reference.dirty
            && blockers == reference.cleanliness_blockers,
        "stale assessment: checkout or branch policy changed; inspect again"
    );
    for (path, expected) in &reference.observed {
        ensure!(
            observe(checkout, path).0 == *expected,
            "stale assessment: evidence '{path}' changed; inspect again"
        );
    }
    checkout.ensure_head()
}

pub fn validate_reference(
    checkout: &Checkout,
    events: &BTreeMap<EventId, Event>,
    reference: &Reference,
) -> Result<Inspection> {
    ensure!(
        matches!(reference.version, 1 | 2),
        "unsupported assessment reference version"
    );
    ensure_observations(checkout, reference)?;
    let current = if reference.version == 2 {
        inspect_typed(checkout, events, reference.knowledge, &reference.inspected)?
    } else {
        inspect(
            checkout,
            events,
            reference.knowledge,
            &reference.observed.keys().cloned().collect::<Vec<_>>(),
        )?
    };
    ensure!(
        current.reference == *reference,
        "stale assessment: claim, evidence or relevant review/replacement heads changed; inspect again"
    );
    Ok(current)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReadRequest {
    pub id: Option<KnowledgeId>,
    #[serde(default)]
    pub history: bool,
    pub history_cursor: Option<String>,
    pub after: Option<KnowledgeId>,
    #[serde(default = "default_budget")]
    pub max_bytes: usize,
    #[serde(default)]
    pub evidence: Vec<String>,
    #[serde(default)]
    pub anchors: Vec<Spec>,
    pub selector: Option<Selector>,
    pub source: Option<String>,
    pub view: Option<View>,
    pub review: Option<EventId>,
    #[serde(default)]
    pub offset: usize,
    pub assessment: Option<Reference>,
    #[serde(default, deserialize_with = "date_option")]
    pub review_before: Option<u64>,
}
fn default_budget() -> usize {
    16000
}
fn date_option<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> std::result::Result<Option<u64>, D::Error> {
    Option::<String>::deserialize(d)?
        .map(|s| parse_review_before(&s).map_err(serde::de::Error::custom))
        .transpose()
}
pub fn read_request(
    checkout: &Checkout,
    events: &BTreeMap<EventId, Event>,
    request: &ReadRequest,
) -> Result<Value> {
    if let Some(id) = request.id {
        ensure!(
            request.after.is_none(),
            "--after is for maintenance lists, not selected detail"
        );
        ensure!(
            request.source.is_some()
                || (request.offset == 0 && request.view.is_none() && request.review.is_none()),
            "source is required for view, review or offset"
        );
        ensure!(
            !(request.history || request.history_cursor.is_some())
                || (request.source.is_none() && request.selector.is_none()),
            "history pages cannot be combined with source pages"
        );
        if let Some(reference) = &request.assessment {
            ensure!(
                reference.knowledge == id,
                "assessment belongs to another claim"
            );
            validate_reference(checkout, events, reference)?;
        }
        detail(
            checkout,
            events,
            id,
            request.max_bytes,
            DetailOptions {
                additional: &request.evidence,
                history: request.history,
                history_cursor: request.history_cursor.as_deref(),
                anchors: &request.anchors,
                selector: request.selector.as_ref(),
                source: request.source.as_deref(),
                view: request.view,
                review: request.review,
                offset: request.offset,
                before: request.review_before,
            },
        )
    } else {
        ensure!(
            !request.history
                && request.history_cursor.is_none()
                && request.source.is_none()
                && request.view.is_none()
                && request.review.is_none()
                && request.offset == 0
                && request.assessment.is_none()
                && request.evidence.is_empty()
                && request.anchors.is_empty()
                && request.selector.is_none(),
            "select a claim ID for evidence, source pages or assessment checks"
        );
        queue(
            checkout,
            events,
            request.max_bytes,
            request.after,
            request.review_before,
        )
    }
}

/// UTC midnight; review age is an explicit advisory filter, never event ordering.
pub fn parse_review_before(value: &str) -> Result<u64> {
    let bytes = value.as_bytes();
    ensure!(
        bytes.len() == 10
            && bytes[4] == b'-'
            && bytes[7] == b'-'
            && bytes
                .iter()
                .enumerate()
                .all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit()),
        "review date must be YYYY-MM-DD in UTC"
    );
    let year: u64 = value[..4].parse()?;
    let month: usize = value[5..7].parse()?;
    let day: u64 = value[8..].parse()?;
    let leap = |y: u64| y.is_multiple_of(4) && (!y.is_multiple_of(100) || y.is_multiple_of(400));
    ensure!(
        (1970..=9999).contains(&year) && (1..=12).contains(&month),
        "review date must be valid and in 1970..9999"
    );
    let months = [
        31,
        if leap(year) { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    ensure!(
        (1..=months[month - 1]).contains(&day),
        "invalid review date"
    );
    let days: u64 = (1970..year)
        .map(|y| if leap(y) { 366 } else { 365 })
        .sum::<u64>()
        + months[..month - 1].iter().sum::<u64>()
        + day
        - 1;
    Ok(days * 86_400_000)
}

fn has_commit(checkout: &Checkout, revision: &Revision) -> Result<bool> {
    Ok(crate::git::command(&checkout.root)?
        .args(["cat-file", "-e", &format!("{}^{{commit}}", revision.commit)])
        .output()?
        .status
        .success())
}

fn attention(
    checkout: &Checkout,
    events: &BTreeMap<EventId, Event>,
    item: &Item,
    observed: &BTreeMap<String, Observation>,
    sources: &BTreeMap<String, Option<crate::source::SourceFile>>,
    cleanliness: (bool, &[String]),
    before: Option<u64>,
) -> Result<Value> {
    let (dirty, cleanliness_blockers) = cleanliness;
    let support_paths: BTreeSet<_> = item.evidence.iter().map(|e| e.path.as_str()).collect();
    let mut reasons = Vec::new();
    let mut blockers = BTreeSet::new();
    if !cleanliness_blockers.is_empty() {
        reasons.push(json!({"code":"safe_cleanliness_unavailable","paths":cleanliness_blockers}));
        blockers.insert("safe_cleanliness_required");
    }
    let paths = |code: &str, values: Vec<String>, reasons: &mut Vec<Value>| {
        if !values.is_empty() {
            reasons.push(json!({"code":code,"paths":values.into_iter().collect::<BTreeSet<_>>()}));
        }
    };
    paths(
        "evidence_changed",
        item.evidence
            .iter()
            .filter(|e| matches!(e.comparison, Comparison::Modified))
            .map(|e| e.path.clone())
            .collect(),
        &mut reasons,
    );
    paths(
        "evidence_missing",
        observed
            .iter()
            .filter(|(p, o)| {
                support_paths.contains(p.as_str()) && o.problem.as_deref() == Some("missing")
            })
            .map(|(p, _)| p.clone())
            .collect(),
        &mut reasons,
    );
    paths(
        "evidence_unavailable",
        observed
            .iter()
            .filter(|(p, o)| {
                support_paths.contains(p.as_str())
                    && o.problem.as_deref().is_some_and(|p| p != "missing")
            })
            .map(|(p, _)| p.clone())
            .collect(),
        &mut reasons,
    );
    let unavailable = item
        .evidence
        .iter()
        .filter(|e| e.anchor.is_some() && matches!(e.comparison, Comparison::Unavailable))
        .map(|e| e.path.clone())
        .collect::<Vec<_>>();
    if !unavailable.is_empty() {
        paths("anchor_unavailable", unavailable, &mut reasons);
        blockers.insert("inspect_or_explicitly_replace_unavailable_anchor");
    }
    if item.review_heads.is_empty() {
        reasons.push(json!({"code":"no_applicable_review"}));
        blockers.insert("obtain_or_merge_supporting_history");
    }
    if item.reviews.iter().any(|r| !r.verified) || item.evidence.is_empty() {
        reasons.push(json!({"code":"missing_complete_review"}));
    }
    if item.review_heads.len() > 1 {
        reasons.push(json!({"code":"review_conflict","heads":item.review_heads}));
    }
    if !item.invalid_reviews.is_empty() {
        reasons.push(json!({"code":"invalid_review_ancestry","historical_count":item.invalid_review_history_count,"frontier":item.invalid_reviews.iter().map(|s|s.event).collect::<Vec<_>>() }));
        blockers.insert("repair_or_obtain_review_history");
    }
    for issue in &item.invalid_relationships {
        reasons.push(json!({"code":if issue.ancestry == Ancestry::NotAncestor {"invalid_relationship_ancestry"} else {"relationship_ancestry_unavailable"},"relationship":issue}));
    }
    if item.relationship_conflict {
        reasons.push(json!({"code":"relationship_conflict"}));
        blockers.insert("unresolved_relationship_conflict");
    }
    // Only history relevant to current validity can queue/block this claim.
    // Retired or future states remain available in selected historical detail.
    if item.review_heads.is_empty() {
        let revision = &item.knowledge.claim.learned_at;
        reasons.push(json!({"code":if has_commit(checkout,revision)? {"review_not_ancestor"} else {"history_unavailable"},"revision":revision}));
    }
    let last_review = item
        .reviews
        .iter()
        .filter(|r| r.verified)
        .filter_map(|r| events.get(&r.event).map(|e| e.created_at_unix_ms))
        .max();
    if let Some(cutoff) = before
        && last_review.is_none_or(|time| time < cutoff)
    {
        reasons.push(
            json!({"code":"review_due","before_unix_ms":cutoff,"last_review_unix_ms":last_review}),
        );
    }
    if item.evidence.is_empty() {
        blockers.insert("complete_support_required");
    }
    if checkout.branch.as_deref() != Some(checkout.default_branch.as_str()) {
        blockers.insert("default_branch_required");
    }
    if dirty {
        blockers.insert("clean_checkout_required");
    }
    for (path, observation) in observed {
        if support_paths.contains(path.as_str()) {
            if observation.problem.is_some() {
                blockers.insert("support_unavailable_or_evidence_change_required");
            } else if observation.sha256.is_some() {
                match crate::knowledge::conversion::inspect(
                    checkout,
                    path,
                    sources[path]
                        .as_ref()
                        .expect("readable observed source")
                        .text
                        .as_bytes(),
                ) {
                    Ok((false, _)) => {
                        blockers.insert("committed_support_required");
                    }
                    Ok((true, _)) => {}
                    Err(error) => {
                        if let Some(blocker) =
                            error.downcast_ref::<crate::knowledge::conversion::Unsupported>()
                        {
                            reasons
                                .push(json!({"code":"unsupported_conversion","blocker":blocker}));
                            blockers.insert("supported_conversion_required");
                        } else {
                            return Err(error);
                        }
                    }
                }
            }
        }
    }
    let needs_promotion = item.knowledge.claim.provisional && !item.applicable_explicit_promotion;
    if needs_promotion {
        reasons.push(json!({"code":"promotion_check"}));
    }
    Ok(
        json!({"reasons":reasons,"action_blockers":blockers,"last_applicable_review_unix_ms":last_review,
        "promotion":{"needed":needs_promotion,"eligible_with_current_support":needs_promotion && blockers.is_empty(),"explicit":true,"blockers":blockers}}),
    )
}

fn fits(value: &Value, budget: usize) -> Result<bool> {
    Ok(serde_json::to_vec(value)?.len() < budget)
}
fn finish(checkout: &Checkout, value: Value, budget: usize) -> Result<Value> {
    ensure!(
        fits(&value, budget)?,
        "current maintenance metadata does not fit the byte budget; use source pages or export the journal for oversized support"
    );
    checkout.ensure_head()?;
    Ok(value)
}

pub fn queue(
    checkout: &Checkout,
    events: &BTreeMap<EventId, Event>,
    budget: usize,
    after: Option<KnowledgeId>,
    before: Option<u64>,
) -> Result<Value> {
    ensure!(
        budget >= 1024,
        "maintenance budget must be at least 1024 bytes"
    );
    let claims = crate::knowledge::projection::reduce(events)?;
    ensure!(
        after.is_none_or(|id| claims.contains_key(&id)),
        "unknown continuation knowledge ID"
    );
    let mut observed = BTreeMap::new();
    let mut sources = BTreeMap::new();
    // One graph assessment and one read per unique attached path for this queue.
    let assessment = super::assess_with_reader(checkout, &claims, None, |path| {
        let read = checkout.observe(path);
        observed.insert(path.to_owned(), read.metadata.clone());
        sources.insert(path.to_owned(), read.source(path));
        Ok(read)
    })?;
    let (dirty, cleanliness_blockers) = checkout.cleanliness()?;
    let mut pending = Vec::new();
    for item in &assessment.items {
        let id = item.knowledge.claim.id;
        if after.is_some_and(|after| id <= after) {
            continue;
        }
        if item.applicable_replacements.len() == 1 && !item.relationship_conflict {
            continue;
        }
        let attention = attention(
            checkout,
            events,
            item,
            &observed,
            &sources,
            (dirty, &cleanliness_blockers),
            before,
        )?;
        if attention["reasons"].as_array().unwrap().is_empty() {
            continue;
        }
        pending.push(json!({"id":id,"statement":item.knowledge.claim.statement,
            "scope":if item.evidence.is_empty(){item.knowledge.claim.scope.iter().collect::<BTreeSet<_>>()}else{item.evidence.iter().map(|e|&e.path).collect::<BTreeSet<_>>()},"status":item.status,
            "review_heads":item.review_heads,"reviews":item.reviews.iter().map(|r|json!({"event":r.event,"actor":r.actor,"revision":r.revision,"created_at_unix_ms":events.get(&r.event).map(|e|e.created_at_unix_ms)})).collect::<Vec<_>>(),"attention":attention}));
    }
    let mut output = json!({"revision":checkout.revision,"contract":CONTRACT,"after":after,
        "review_before_unix_ms":before,"files_read":assessment.files_read,"assessed":assessment.items.len(),"next_after":null,"remaining":pending.len(),"items":[]});
    for (index, item) in pending.iter().enumerate() {
        let mut next = output.clone();
        next["items"].as_array_mut().unwrap().push(item.clone());
        next["remaining"] = json!(pending.len() - index - 1);
        next["next_after"] = if index + 1 < pending.len() {
            item["id"].clone()
        } else {
            Value::Null
        };
        if !fits(&next, budget)? {
            ensure!(
                !output["items"].as_array().unwrap().is_empty(),
                "maintenance item {} exceeds --max-bytes; inspect that ID or export the journal",
                item["id"]
            );
            break;
        }
        output = next;
    }
    finish(checkout, output, budget)
}
