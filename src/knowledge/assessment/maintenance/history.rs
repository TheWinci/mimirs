//! Explicit review-history pages, bound to the exact current assessment.
use super::*;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    version: u32,
    knowledge: KnowledgeId,
    assessment_sha256: String,
    review: EventId,
    offset: usize,
}

fn binding(inspection: &Inspection) -> Result<String> {
    Ok(fingerprint(&serde_json::to_vec(&inspection.reference)?))
}
fn cursor(inspection: &Inspection, review: EventId, offset: usize) -> Result<Value> {
    Ok(json!(serde_json::to_string(&Cursor {
        version: 1,
        knowledge: inspection.reference.knowledge,
        assessment_sha256: binding(inspection)?,
        review,
        offset,
    })?))
}
pub(super) fn start(inspection: &Inspection, states: &[State]) -> Result<Value> {
    states
        .first()
        .map_or(Ok(Value::Null), |s| cursor(inspection, s.event, 0))
}

pub(super) fn page(
    inspection: &Inspection,
    states: &[State],
    token: Option<&str>,
    budget: usize,
) -> Result<Value> {
    let (start, offset) = if let Some(token) = token {
        let c: Cursor = serde_json::from_str(token)?;
        ensure!(
            c.version == 1
                && c.knowledge == inspection.reference.knowledge
                && c.assessment_sha256 == binding(inspection)?,
            "stale or mismatched history continuation; refresh maintenance detail"
        );
        (
            states
                .iter()
                .position(|s| s.event == c.review)
                .context("unknown history review")?,
            c.offset,
        )
    } else {
        (0, 0)
    };
    let mut value = json!({"assessment":inspection.reference,"contract":CONTRACT,
        "history_total":states.len(),"reviews":[],"next_history_cursor":null,
        "paging":"Offsets count replaced review IDs, evidence entries, then original scope paths for the creation state. A continuation is invalid after the assessment or history changes."});
    for (index, state) in states.iter().enumerate().skip(start) {
        let offset = if index == start { offset } else { 0 };
        let initial = state.event == inspection.item.knowledge.created_event;
        let scope = if initial {
            inspection.item.knowledge.claim.scope.as_slice()
        } else {
            &[]
        };
        let total = state.replaces.len() + state.evidence.len() + scope.len();
        ensure!(
            offset <= total,
            "history offset is outside the selected review"
        );
        let entry = json!({"event":state.event,"actor":state.actor,"revision":state.revision,
            "verified":state.verified,"promote":state.promote,"replaces":[],"evidence":[],"scope":[],
            "offset":offset,"total_rows":total,"complete":false});
        let previous = value.clone();
        value["reviews"].as_array_mut().unwrap().push(entry);
        let parents = state.replaces.iter().map(|v| ("replaces", json!(v)));
        let evidence = state.evidence.iter().map(|v| ("evidence", json!(v)));
        let mut end = offset;
        let scope = scope.iter().map(|v| ("scope", json!(v)));
        for (row, (field, item)) in parents
            .chain(evidence)
            .chain(scope)
            .enumerate()
            .skip(offset)
        {
            let mut next = value.clone();
            next["reviews"].as_array_mut().unwrap().last_mut().unwrap()[field]
                .as_array_mut()
                .unwrap()
                .push(item);
            next["next_history_cursor"] = cursor(inspection, state.event, row + 1)?;
            if !fits(&next, budget)? {
                break;
            }
            value = next;
            end = row + 1;
        }
        if end == offset && end < total {
            ensure!(
                !previous["reviews"].as_array().unwrap().is_empty(),
                "history entry does not fit the byte budget; use selected-review source access or export the journal"
            );
            return Ok(previous);
        }
        value["reviews"].as_array_mut().unwrap().last_mut().unwrap()["complete"] =
            json!(end == total);
        value["next_history_cursor"] = if end < total {
            cursor(inspection, state.event, end)?
        } else if let Some(next) = states.get(index + 1) {
            cursor(inspection, next.event, 0)?
        } else {
            Value::Null
        };
        if !fits(&value, budget)? {
            ensure!(
                !previous["reviews"].as_array().unwrap().is_empty(),
                "history metadata does not fit the byte budget; use selected-review source access or export the journal"
            );
            return Ok(previous);
        }
        if end < total {
            break;
        }
    }
    Ok(value)
}
