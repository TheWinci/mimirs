use super::rendering::{diff, recorded};
use super::*;

fn rendered(
    source: &crate::source::SourceFile,
    anchor: &evidence::Anchor,
) -> Result<(String, Value)> {
    let r = evidence::resolve(source, &anchor.selector, Some(&anchor.provider))?;
    let text = r
        .regions
        .iter()
        .map(|r| format!("--- {} ---\n{}\n", r.role, r.text))
        .collect::<Vec<_>>()
        .join("\n");
    Ok((
        text,
        json!({"provider":r.provider,"region_sha256":r.region_sha256,"regions":r.regions.iter().map(|r|json!({"role":r.role,"span":r.span})).collect::<Vec<_>>()}),
    ))
}
pub(super) fn page(
    checkout: &Checkout,
    inspection: &Inspection,
    options: &DetailOptions<'_>,
    budget: usize,
) -> Result<Value> {
    let path = options
        .source
        .context("--selector requires --source PATH")?;
    let selector = options.selector.context("selector required")?;
    let states = reviews::states(&inspection.claims[&inspection.reference.knowledge])?;
    let review = options.review.or(inspection.item.assessed_review);
    let state = review.and_then(|id| states.iter().find(|s| s.event == id));
    if options.review.is_some() {
        ensure!(state.is_some(), "unknown review ID");
    }
    let support = state.and_then(|s| {
        s.evidence.iter().find(|e| {
            e.evidence.path == path
                && e.evidence
                    .anchor
                    .as_ref()
                    .is_some_and(|a| &a.selector == selector)
        })
    });
    let explicit = options
        .anchors
        .iter()
        .find(|s| s.path == path && s.selector.as_ref() == Some(selector))
        .cloned()
        .map(|mut spec| {
            if spec.provider.is_none() {
                spec.provider = Some(evidence::provider(path));
            }
            spec
        });
    let recorded_spec = support.map(|s| Spec::from_evidence(&s.evidence));
    let proposed = explicit.as_ref().or_else(|| {
        inspection.reference.inspected.iter().find(|s| {
            if let Some(recorded) = &recorded_spec {
                *s == recorded
            } else {
                s.path == path && s.selector.as_ref() == Some(selector)
            }
        })
    });
    ensure!(
        support.is_some() || proposed.is_some(),
        "anchor selector was not inspected; add --anchor explicitly"
    );
    let view = options.view.unwrap_or(View::Current);
    ensure!(
        view != View::Canonical,
        "canonical blob pages require whole-file source access without --selector"
    );
    let mut metadata = Value::Null;
    let result = (|| -> Result<String> {
        let current = || -> Result<(String, Value)> {
            let spec = proposed.context("anchor is outside current inspected support")?;
            let source = inspection
                .sources
                .get(path)
                .and_then(Option::as_ref)
                .context("anchor source missing")?;
            let provider = spec
                .provider
                .clone()
                .unwrap_or_else(|| evidence::provider(path));
            rendered(
                source,
                &evidence::Anchor {
                    selector: selector.clone(),
                    provider,
                    region_sha256: String::new(),
                },
            )
        };
        if view == View::Current {
            let (text, m) = current()?;
            metadata = m;
            return Ok(text);
        }
        let state = state.context("select --review EVENT for recorded anchor support")?;
        let support = &support
            .context("selector is not attached to selected review")?
            .evidence;
        let old = recorded(checkout, &state.revision, support)?;
        let bytes = old.bytes.with_context(|| {
            old.unavailable
                .unwrap_or_else(|| "recorded support unavailable".into())
        })?;
        let (old, old_meta) = rendered(
            &crate::source::SourceFile {
                path: path.into(),
                text: String::from_utf8(bytes)?,
            },
            support.anchor.as_ref().unwrap(),
        )?;
        ensure!(
            old_meta["region_sha256"] == support.anchor.as_ref().unwrap().region_sha256,
            "recorded region digest mismatch"
        );
        if view == View::Recorded {
            metadata = old_meta;
            Ok(old)
        } else {
            let (new, new_meta) = current()?;
            metadata = json!({"recorded":old_meta,"current":new_meta});
            diff(old.as_bytes(), new.as_bytes())
        }
    })();
    let (text, problem) = match result {
        Ok(text) => (text, None),
        Err(e) => (String::new(), Some(format!("{e:#}"))),
    };
    ensure!(
        options.offset <= text.len() && text.is_char_boundary(options.offset),
        "anchor offset must be an in-range UTF-8 byte boundary"
    );
    let mut value = json!({"assessment":inspection.reference,"contract":evidence::CONTRACT,"path":path,"selector":selector,
        "view":format!("{view:?}"),"review":review,"region":metadata,"unavailable":problem,"offset":options.offset,
        "total_bytes":text.len(),"end":options.offset,"next_offset":null,"text":""});
    let mut end = text.len().min(options.offset.saturating_add(budget));
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    loop {
        value["text"] = json!(&text[options.offset..end]);
        value["end"] = json!(end);
        value["next_offset"] = if end < text.len() {
            json!(end)
        } else {
            Value::Null
        };
        if fits(&value, budget)? {
            break;
        }
        ensure!(end > options.offset, "budget too small for anchor metadata");
        end = options.offset + (end - options.offset) / 2;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
    }
    ensure!(
        end > options.offset || end == text.len(),
        "budget too small for anchored content"
    );
    ensure_observations(checkout, &inspection.reference)?;
    finish(checkout, value, budget)
}

pub(super) fn summaries(inspection: &Inspection) -> Result<Vec<Value>> {
    let mut out = Vec::new();
    for spec in inspection
        .reference
        .inspected
        .iter()
        .filter(|s| s.selector.is_some())
    {
        let resolved = inspection
            .sources
            .get(&spec.path)
            .and_then(Option::as_ref)
            .context("anchor source unavailable")
            .and_then(|source| evidence::capture_from_source(source, spec));
        out.push(json!({"selector":spec,"current":resolved.as_ref().ok(),"unavailable":resolved.as_ref().err().map(|e|format!("{e:#}")),
            "access":{"source":spec.path,"selector":spec.selector,"views":["current","recorded","diff"]}}));
    }
    Ok(out)
}
