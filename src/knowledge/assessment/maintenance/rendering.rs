//! Selected evidence detail, source pages, and recorded/current diff rendering.
use super::*;
use std::io::Write;

#[derive(Clone, Copy, Debug, PartialEq, Eq, clap::ValueEnum, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum View {
    Current,
    Recorded,
    Canonical,
    Diff,
}

#[derive(Default)]
pub struct DetailOptions<'a> {
    pub additional: &'a [String],
    pub history: bool,
    pub history_cursor: Option<&'a str>,
    pub anchors: &'a [Spec],
    pub selector: Option<&'a Selector>,
    pub source: Option<&'a str>,
    pub view: Option<View>,
    pub review: Option<EventId>,
    pub offset: usize,
    pub before: Option<u64>,
}

pub(super) struct Recorded {
    pub(super) bytes: Option<Vec<u8>>,
    pub(super) unavailable: Option<String>,
    pub(super) canonical: Option<Vec<u8>>,
}
pub(super) fn recorded(
    checkout: &Checkout,
    revision: &Revision,
    evidence: &FileEvidence,
) -> Result<Recorded> {
    let output = crate::git::command(&checkout.root)?
        .args(["show", &format!("{}:{}", revision.commit, evidence.path)])
        .output()?;
    let canonical = output.status.success().then_some(output.stdout);
    let bytes = canonical
        .as_deref()
        .and_then(|blob| crate::knowledge::conversion::reconstruct(evidence, blob));
    let problem = if canonical.is_none() {
        Some("recorded revision or file unavailable")
    } else if bytes.is_none() {
        Some(
            "reconstructed bytes do not match the recorded hash; exact observed bytes are unavailable; canonical Git blob is available with --view canonical",
        )
    } else if std::str::from_utf8(bytes.as_ref().unwrap()).is_err() {
        Some("recorded source is not valid UTF-8")
    } else {
        None
    };
    Ok(Recorded {
        bytes: if problem.is_none() { bytes } else { None },
        unavailable: problem.map(str::to_owned),
        canonical,
    })
}

pub(super) fn diff(old: &[u8], new: &[u8]) -> Result<String> {
    if old == new {
        return Ok(String::new());
    }
    let mut left = tempfile::NamedTempFile::new()?;
    let mut right = tempfile::NamedTempFile::new()?;
    left.write_all(old)?;
    right.write_all(new)?;
    let output = crate::git::command(&std::env::current_dir()?)?
        .args([
            "diff",
            "--no-index",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--text",
            "--unified=3",
        ])
        .arg(left.path())
        .arg(right.path())
        .output()?;
    ensure!(
        matches!(output.status.code(), Some(0 | 1)),
        "cannot produce evidence diff"
    );
    let text = String::from_utf8(output.stdout)?;
    let hunks = text.find("@@").map_or("", |i| &text[i..]);
    Ok(format!(
        "--- recorded support\n+++ current working bytes\n{hunks}"
    ))
}

fn changes(checkout: &Checkout, states: &[State]) -> Result<Vec<Value>> {
    let mut values = Vec::new();
    for state in states {
        let output = crate::git::command(&checkout.root)?
            .args([
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--name-only",
                "-z",
                &state.revision.commit,
                "--",
                ".",
                ":(exclude).mimirs/knowledge",
            ])
            .output()?;
        if !output.status.success() {
            values.push(json!({"review":state.event,"unavailable":true}));
            continue;
        }
        let untracked = crate::git::command(&checkout.root)?
            .args([
                "ls-files",
                "--others",
                "--exclude-standard",
                "-z",
                "--",
                ".",
                ":(exclude).mimirs/knowledge",
            ])
            .output()?;
        ensure!(
            untracked.status.success(),
            "cannot enumerate untracked paths"
        );
        let mut paths: BTreeSet<String> = BTreeSet::new();
        for bytes in [&output.stdout, &untracked.stdout] {
            for p in bytes.split(|b| *b == 0).filter(|p| !p.is_empty()) {
                paths.insert(String::from_utf8_lossy(p).into_owned());
            }
        }
        values.push(json!({"review":state.event,"revision":state.revision,"paths":paths.iter().take(20).collect::<Vec<_>>(),"omitted":paths.len().saturating_sub(20),
            "scope":"tracked working-tree differences from review and untracked nonignored paths; not a dependency analysis"}));
    }
    Ok(values)
}

pub fn detail(
    checkout: &Checkout,
    events: &BTreeMap<EventId, Event>,
    id: KnowledgeId,
    budget: usize,
    options: DetailOptions<'_>,
) -> Result<Value> {
    ensure!(
        budget >= 1024,
        "maintenance budget must be at least 1024 bytes"
    );
    let inspection = inspect_typed(
        checkout,
        events,
        id,
        &evidence::inputs(options.additional, options.anchors)?,
    )?;
    if options.selector.is_some() {
        return anchors::page(checkout, &inspection, &options, budget);
    }
    let states = reviews::states(&inspection.claims[&id])?;
    if options.history || options.history_cursor.is_some() {
        let value = history::page(&inspection, &states, options.history_cursor, budget)?;
        ensure_observations(checkout, &inspection.reference)?;
        return finish(checkout, value, budget);
    }
    let attention = attention(
        checkout,
        events,
        &inspection.item,
        &inspection.reference.observed,
        &inspection.sources,
        (
            inspection.reference.dirty,
            &inspection.reference.cleanliness_blockers,
        ),
        options.before,
    )?;
    if let Some(path) = options.source {
        validate_path(path)?;
        let view = options.view.unwrap_or(View::Current);
        let state = options
            .review
            .and_then(|id| states.iter().find(|s| s.event == id))
            .or_else(|| {
                if options.review.is_none() {
                    inspection
                        .item
                        .assessed_review
                        .and_then(|id| states.iter().find(|s| s.event == id))
                } else {
                    None
                }
            });
        if options.review.is_some() {
            ensure!(state.is_some(), "unknown review ID for this claim");
        }
        let mut unavailable;
        let (text, sha) = if view == View::Current {
            ensure!(
                inspection.reference.observed.contains_key(path),
                "path is outside inspected support; add --evidence PATH explicitly"
            );
            let (obs, bytes) = observe(checkout, path);
            ensure!(
                inspection.reference.observed.get(path) == Some(&obs),
                "stale assessment: evidence changed while reading source page"
            );
            unavailable = obs.problem;
            (
                bytes
                    .and_then(|b| String::from_utf8(b).ok())
                    .unwrap_or_default(),
                obs.sha256,
            )
        } else {
            let state=state.context("select --review EVENT for recorded evidence when no single applicable review exists")?;
            let support = state
                .evidence
                .iter()
                .find(|s| s.evidence.path == path)
                .context("path is not attached to the selected review")?;
            let mut old = recorded(checkout, &state.revision, &support.evidence)?;
            if view == View::Canonical {
                old.bytes = old.canonical.take();
                old.unavailable = old
                    .bytes
                    .is_none()
                    .then(|| "canonical Git blob unavailable".into());
            }
            unavailable = old.unavailable;
            let text = if let Some(old) = old.bytes {
                if matches!(view, View::Recorded | View::Canonical) {
                    String::from_utf8(old)?
                } else {
                    ensure!(
                        inspection.reference.observed.contains_key(path),
                        "path is outside inspected support; add --evidence PATH explicitly"
                    );
                    let (obs, live) = observe(checkout, path);
                    ensure!(
                        inspection.reference.observed.get(path) == Some(&obs),
                        "stale assessment: evidence changed while reading diff"
                    );
                    if obs.problem.as_deref().is_some_and(|p| p != "missing") {
                        unavailable = obs.problem;
                        String::new()
                    } else {
                        diff(&old, &live.unwrap_or_default())?
                    }
                }
            } else {
                String::new()
            };
            let sha = if view == View::Canonical && unavailable.is_none() {
                fingerprint(text.as_bytes())
            } else {
                support.evidence.sha256.clone()
            };
            (text, Some(sha))
        };
        ensure!(
            options.offset <= text.len() && text.is_char_boundary(options.offset),
            "source offset must be an in-range UTF-8 byte boundary"
        );
        let mut value = json!({"assessment":inspection.reference,"contract":CONTRACT,"path":path,"view":format!("{view:?}"),"review":state.map(|s|s.event),
            "sha256":sha,"byte_identity":if view == View::Canonical {"canonical_git_blob"} else if view == View::Diff {"diff"} else {"exact_observed"},"unavailable":unavailable,"total_bytes":text.len(),"offset":options.offset,"end":options.offset,"next_offset":null,"text":""});
        // A raw byte already costs at least one output byte. Limit the search
        // before constructing UTF-8 boundaries; then pack in logarithmic steps.
        let mut upper = text.len().min(options.offset.saturating_add(budget));
        while !text.is_char_boundary(upper) {
            upper -= 1;
        }
        let ends: Vec<_> = std::iter::once(options.offset)
            .chain(
                text[options.offset..upper]
                    .char_indices()
                    .map(|(i, c)| options.offset + i + c.len_utf8()),
            )
            .collect();
        let lines = crate::analysis::LineIndex::new(&text);
        let set_page = |value: &mut Value, end: usize| {
            value["text"] = json!(&text[options.offset..end]);
            value["end"] = json!(end);
            value["next_offset"] = if end < text.len() {
                json!(end)
            } else {
                Value::Null
            };
            if view != View::Diff && unavailable.is_none() {
                let span = lines.span(options.offset, end);
                value["lines"] = json!([span.line_start, span.line_end]);
            }
        };
        set_page(&mut value, upper);
        if !fits(&value, budget)? {
            let (mut low, mut high) = (0, ends.len());
            let mut best = options.offset;
            while low < high {
                let middle = (low + high) / 2;
                set_page(&mut value, ends[middle]);
                if fits(&value, budget)? {
                    best = ends[middle];
                    low = middle + 1;
                } else {
                    high = middle;
                }
            }
            set_page(&mut value, best);
        }
        ensure!(
            value["end"].as_u64().unwrap() as usize > options.offset
                || options.offset == text.len(),
            "source content does not fit the byte budget; inspect a smaller source region or export the journal"
        );
        ensure_observations(checkout, &inspection.reference)?;
        return finish(checkout, value, budget);
    }
    ensure!(
        options.offset == 0 && options.review.is_none() && options.view.is_none(),
        "source paging options require --source PATH"
    );
    let mut item = serde_json::to_value(&inspection.item)?;
    item.as_object_mut().unwrap().remove("promotions");
    item["knowledge"]["claim"]
        .as_object_mut()
        .unwrap()
        .remove("scope");
    item["original_scope_paths"] = json!(inspection.item.knowledge.claim.scope.len());
    item["scope"] = json!(inspection.reference.support_paths);
    item["invalid_reviews"] = json!(
        inspection
            .item
            .invalid_reviews
            .iter()
            .map(|s| json!({"event":s.event,"revision":s.revision}))
            .collect::<Vec<_>>()
    );
    item["promotion_history_count"] = json!(inspection.item.promotions.len());
    item["reviews"] = json!(inspection.item.reviews.iter().map(|s| json!({"event":s.event,"actor":s.actor,"revision":s.revision,"verified":s.verified,"promote":s.promote})).collect::<Vec<_>>());
    for evidence in item["evidence"].as_array_mut().unwrap() {
        evidence.as_object_mut().unwrap().remove("current_text");
        evidence.as_object_mut().unwrap().remove("text_truncated");
    }
    let mut value = json!({"assessment":inspection.reference,"contract":CONTRACT,"item":item,"attention":attention,
        "history_total":states.len(),"next_history_cursor":history::start(&inspection,&states)?,
        "recorded_support":inspection.item.reviews.iter().map(|s|json!({"review":s.event,"revision":s.revision,"evidence":s.evidence})).collect::<Vec<_>>(),
        "changes_since_review":changes(checkout,&inspection.item.reviews)?,"diffs":[],
        "source_access":"Use maintenance ID --source PATH --view current|recorded|canonical|diff --review EVENT --offset BYTE. Additional support must first be inspected with --evidence PATH. Page bytes are exact, not complete functions."});
    let anchor_summaries = anchors::summaries(&inspection)?;
    if !anchor_summaries.is_empty() {
        value["anchors"] = json!(anchor_summaries);
        value["anchor_contract"] = json!(evidence::CONTRACT);
    }
    for state in &inspection.item.reviews {
        for support in &state.evidence {
            if support.evidence.anchor.is_some() {
                continue;
            }
            let (obs, current) = observe(checkout, &support.evidence.path);
            ensure!(
                inspection.reference.observed.get(&support.evidence.path) == Some(&obs),
                "stale assessment: evidence changed while preparing detail"
            );
            if obs.sha256.as_deref() == Some(&support.evidence.sha256) {
                continue;
            }
            let old = recorded(checkout, &state.revision, &support.evidence)?;
            let unavailable = old
                .unavailable
                .or_else(|| obs.problem.filter(|p| p != "missing"));
            let text = if unavailable.is_none() {
                diff(&old.bytes.unwrap_or_default(), &current.unwrap_or_default())?
            } else {
                String::new()
            };
            let prefix = super::preview(&text, 1024);
            let entry = json!({"path":support.evidence.path,"review":state.event,"unavailable":unavailable,"text":prefix,"next_offset":if prefix.len()<text.len(){Some(prefix.len())}else{None},"total_bytes":text.len()});
            value["diffs"].as_array_mut().unwrap().push(entry);
        }
    }
    if !fits(&value, budget)? {
        value["diffs"] = json!([]);
        value["diffs_omitted"] = json!(true);
    }
    if !fits(&value, budget)? {
        value["changes_since_review"] = json!([]);
        value["changed_path_context_omitted"] = json!(true);
    }
    ensure_observations(checkout, &inspection.reference)?;
    finish(checkout, value, budget)
}
