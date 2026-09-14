//! One read-only task request. No CLI subprocesses, journal writes or semantic review.
use crate::knowledge::assessment::query;
use crate::{
    embedding,
    knowledge::{self, checkout::Checkout},
    retrieval::{compact::Prepared, query::Retriever},
};
use anyhow::{Result, ensure};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
};

pub const DEFAULT_BYTES: usize = 16_000;
const CONTRACT: &str = "Source excerpts cite indexed bytes; never apply their spans to changed working files. Knowledge status compares declared evidence, not semantic truth or unlisted dependencies. Reads do not record reviews. Use knowledge maintenance ID for complete support and changes.";

#[derive(Clone, Copy, Default, clap::ValueEnum)]
pub enum Output {
    #[default]
    Text,
    Json,
}

pub struct Request<'a> {
    pub output: Output,
    pub intent: crate::retrieval::navigation::Intent,
    pub root: &'a Path,
    pub query: &'a str,
    pub knowledge: Option<crate::config::KnowledgeMode>,
    pub source_limit: usize,
    pub knowledge_limit: usize,
    pub max_bytes: usize,
    pub repository: Option<&'a str>,
    pub state: Option<&'a Path>,
    pub default_branch: Option<&'a str>,
}

#[derive(Default)]
struct LiveFiles {
    root: PathBuf,
    files: BTreeMap<String, crate::source::observation::Observed>,
}
impl LiveFiles {
    fn get(&mut self, path: &str) -> &crate::source::observation::Observed {
        self.files
            .entry(path.to_owned())
            .or_insert_with(|| crate::source::observation::Observed::read(&self.root, path))
    }
    fn read(&mut self, path: &str) -> Result<crate::source::observation::Observed> {
        Ok(self.get(path).clone())
    }
}

fn short_error(error: &anyhow::Error) -> String {
    let text = format!("{error:#}");
    if text.len() <= 256 {
        text
    } else {
        format!("{} [error shortened]", crate::files::preview(&text, 230))
    }
}
fn size(value: &Value) -> usize {
    serde_json::to_vec(value).expect("JSON value").len() + 1
}
fn escaped(text: &str) -> usize {
    serde_json::to_string(text).expect("string").len() - 2
}

fn knowledge(
    request: &Request<'_>,
    paths: &BTreeSet<String>,
    live: &mut LiveFiles,
    target: &mut Option<crate::status::Target>,
) -> Result<query::Selection> {
    if crate::config::knowledge_mode(request.root, request.knowledge)?
        == crate::config::KnowledgeMode::Off
    {
        return Ok(query::Selection {
            summary: json!({"status":"disabled","reason":"knowledge consumption is off","items":[]}),
            items: vec![],
        });
    }
    let settings = knowledge::settings::resolve(
        request.root,
        request.repository,
        request.default_branch,
        None,
    )?;
    *target = Some(knowledge::settings::diagnostic_target(
        request.root,
        request.state,
        settings.repository.as_ref(),
        Some(&settings.default_branch),
    ));
    let Some(repository) = settings.repository else {
        return Ok(query::Selection {
            summary: json!({"status":"not_configured","reason":"run mimirs knowledge setup once for local knowledge","items":[]}),
            items: vec![],
        });
    };
    repository.validate()?;
    let state = request
        .state
        .map(Path::to_path_buf)
        .unwrap_or_else(|| request.root.join(".mimirs/knowledge"));
    ensure!(
        state
            .join("repositories")
            .join(knowledge::fingerprint(repository.0.as_bytes()))
            .try_exists()?,
        "unknown local knowledge repository; configure or pull it explicitly"
    );
    let events = knowledge::read_events(&state, &repository)?;
    let checkout =
        Checkout::open(request.root, &repository)?.with_default_branch(&settings.default_branch)?;
    let selection = query::select(
        &checkout,
        &events,
        request.query,
        paths,
        request.knowledge_limit,
        |path| live.read(path),
    )?;
    checkout.ensure_head()?;
    Ok(selection)
}

/// Reuse the retriever across tool calls; its injected embedder initializes lazily.
pub fn execute(
    request: &Request<'_>,
    retriever: &mut Retriever,
    make_embedder: impl FnOnce() -> Result<embedding::Embedder>,
) -> Result<Value> {
    query::validate(request.query, request.knowledge_limit)?;
    ensure!(
        (1..=100).contains(&request.source_limit),
        "limit must be between 1 and 100"
    );
    ensure!(
        request.max_bytes >= 1024,
        "context budget must be at least 1024 bytes"
    );
    let root = request.root.canonicalize()?;
    let mut live = LiveFiles {
        root,
        ..Default::default()
    };
    let mut paths = BTreeSet::new();
    let mut prepared: Option<Prepared> = None;
    let mut navigation = None;
    let source = match retriever.retrieve_with_intent(
        request.root,
        request.query,
        request.source_limit,
        true,
        make_embedder,
        request.intent,
        &mut |path| live.get(path).metadata.sha256.clone(),
    ) {
        Ok(retrieved) => {
            navigation = retrieved.navigation;
            paths.extend(
                retrieved
                    .results
                    .source
                    .iter()
                    .map(|f| f.hit.representative.path.clone()),
            );
            let current: Vec<_> = retrieved.results.source.iter().chain(&retrieved.results.docs).map(|f| {
                let path = &f.hit.representative.path;
                let observation = json!(&live.get(path).metadata);
                let mut value = json!({"path":path,
                    "comparison":if observation["problem"]=="missing"{"Missing"}else if !observation["problem"].is_null(){"Unavailable"}else if observation["sha256"]==f.snapshot_hash{"Unchanged"}else{"Modified"}});
                if !observation["problem"].is_null() { value["problem"] = observation["problem"].clone(); }
                value
            }).collect();
            let empty = retrieved.results.source.is_empty() && retrieved.results.docs.is_empty();
            if !empty {
                prepared = retrieved.compact;
            }
            json!({"status":if empty{"empty"}else{"ok"},"retrieval":"success","source_files":retrieved.results.source.len(),
                "documentation_files":retrieved.results.docs.len(),"current":current,"text":""})
        }
        Err(error) => {
            json!({"status":"unavailable","retrieval":"failed","error":short_error(&error),"text":""})
        }
    };
    let mut target = Some(knowledge::settings::diagnostic_target(
        request.root,
        request.state,
        request
            .repository
            .map(|id| knowledge::model::RepositoryId(id.into()))
            .as_ref(),
        request.default_branch,
    ));
    let selection = knowledge(request, &paths, &mut live, &mut target).unwrap_or_else(|error| {
        query::Selection {
            summary: json!({"status":"unavailable","error":short_error(&error),"items":[]}),
            items: vec![],
        }
    });
    let mut value = json!({"version":1,"contract":CONTRACT,"max_bytes":request.max_bytes,
        "live_files_read":live.files.len(),"source":source,"knowledge":selection.summary});
    if request.intent.architecture(request.query) {
        value["navigation"] = navigation.unwrap_or_else(|| json!({"status":"unavailable","gaps":["source retrieval unavailable; no adjacency established"]}));
        for field in ["edges", "operations"] {
            while size(&value["navigation"]) > request.max_bytes / 3
                && value["navigation"][field]
                    .as_array()
                    .is_some_and(|items| !items.is_empty())
            {
                value["navigation"][field].as_array_mut().unwrap().pop();
                let omitted = format!("omitted_{field}");
                value["navigation"][&omitted] =
                    (value["navigation"][&omitted].as_u64().unwrap_or(0) + 1).into();
            }
        }
        if size(&value["navigation"]) > request.max_bytes / 3 {
            value["navigation"] = json!({"status":"budget_exceeded","gaps":["navigation omitted to preserve source and whole claims within the response budget"]});
        }
    }
    // Drop an entire overflowing source section, never individual navigation paths.
    if size(&value) > request.max_bytes {
        let mut without_source = value.clone();
        source_overflow(&mut without_source);
        if size(&without_source) <= request.max_bytes {
            value = without_source;
            prepared = None;
        } else {
            value["knowledge"] = json!({"status":selection.summary["status"],"metadata_omitted":true,
                "items":[],"omitted_items":selection.items.len(),
                "next_detail":selection.items.first().map(|i|i["id"].clone()),"recovery":"increase --max-bytes"});
            if size(&value) > request.max_bytes {
                source_overflow(&mut value);
                prepared = None;
            }
        }
    }
    ensure!(
        size(&value) <= request.max_bytes,
        "context metadata exceeds --max-bytes; increase the explicit budget"
    );
    let allowance = request.max_bytes - size(&value);
    let knowledge_allowance = if prepared.is_some() {
        allowance / 4
    } else {
        allowance
    };
    let mut count = pack_knowledge(&mut value, &selection.items, knowledge_allowance);
    if let Some(source) = &prepared {
        loop {
            let remaining = request.max_bytes - size(&value);
            match match request.output {
                Output::Json => source.render(remaining, &escaped),
                Output::Text => source.render_readable(remaining, &escaped),
            } {
                Ok(text) => {
                    value["source"]["text"] = json!(text);
                    break;
                }
                Err(_) if count > 0 => {
                    count -= 1;
                    set_items(&mut value, &selection.items, count);
                }
                Err(_) => {
                    source_overflow(&mut value);
                    set_items(&mut value, &selection.items, 0);
                    let remaining = request.max_bytes.saturating_sub(size(&value));
                    pack_knowledge(&mut value, &selection.items, remaining);
                    break;
                }
            }
        }
    }
    ensure!(
        size(&value) <= request.max_bytes,
        "context output budget exceeded"
    );
    crate::status::observation(
        request.root,
        "context-source",
        "source",
        source["status"].as_str().unwrap_or("unknown"),
        None,
        source["error"].as_str(),
    );
    let state = match selection.summary["status"].as_str() {
        Some("disabled") => None,
        Some("empty") => Some("configured_empty"),
        Some("ok" | "no_match") => Some("assessed"),
        Some("not_configured") => Some("unconfigured"),
        _ => Some("unavailable"),
    };
    if let Some(state) = state {
        crate::status::observation(
            request.root,
            "context-knowledge",
            "knowledge",
            state,
            target,
            selection.summary["error"].as_str(),
        );
    }
    Ok(value)
}

fn source_overflow(value: &mut Value) {
    let retrieval = value["source"]["retrieval"].clone();
    value["source"] = json!({"status":"budget_exceeded","retrieval":retrieval,
        "reason":"complete source navigation/current metadata cannot fit; increase --max-bytes or lower --limit","text":""});
}
fn set_items(value: &mut Value, items: &[Value], count: usize) {
    value["knowledge"]["items"] = json!(items[..count]);
    if !items.is_empty() {
        value["knowledge"]["omitted_items"] = json!(items.len() - count);
        value["knowledge"]["next_detail"] = items
            .get(count)
            .map(|i| i["id"].clone())
            .unwrap_or(Value::Null);
    }
}
fn pack_knowledge(value: &mut Value, items: &[Value], allowance: usize) -> usize {
    let ceiling = size(value) + allowance;
    let mut count = 0;
    for next in 1..=items.len() {
        set_items(value, items, next);
        if size(value) > ceiling {
            set_items(value, items, count);
            break;
        }
        count = next;
    }
    count
}

#[cfg(test)]
#[path = "../../tests/unit/context/task.rs"]
mod tests;
