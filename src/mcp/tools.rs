use super::Options;
use crate::knowledge::evidence::{self, Spec};
use crate::knowledge::operations::{Reviewed, Support, Write as KnowledgeWrite};
use crate::{
    context::task,
    embedding,
    knowledge::assessment::maintenance,
    knowledge::{self, ReplacementRequest, Store, checkout::Checkout, model::*},
    retrieval::query::Retriever,
};
use anyhow::{Result, ensure};
use serde::Deserialize;
use serde_json::{Value, json};

const MAX_BYTES: usize = 256_000;
pub const NAMES: [&str; 5] = ["context", "maintenance", "learn", "review", "replace"];

fn object(properties: Value, required: &[&str]) -> Value {
    json!({"type":"object","properties":properties,"required":required,"additionalProperties":false})
}
pub fn list() -> Value {
    let budget = json!({"type":"integer","minimum":1024,"maximum":MAX_BYTES,"default":16000});
    let string = json!({"type":"string"});
    let paths = json!({"type":"array","items":{"type":"string"},"description":"Whole-file paths relative to the checkout. Optional precise Rust declaration selectors use anchors."});
    let named = object(json!({"kind":string,"name":string}), &["kind", "name"]);
    let selector = object(
        json!({"version":{"type":"integer","enum":[1]},"kind":string,"name":string,"owners":{"type":"array","items":named}}),
        &["version", "kind", "name"],
    );
    let anchors = json!({"type":"array","items":object(json!({"path":string,"selector":selector,"provider":string}),&["path","selector"]),"description":"Complete explicit Rust declaration selectors. Include every recorded dependency. Default review/replace retains typed support when both evidence and anchors are omitted."});
    let assessment = json!({"type":"object","description":"Exact assessment object or complete maintenance response from this checkout; unknown reference versions and fields are rejected."});
    let mut definitions = vec![
        (
            "context",
            "Recommended task entry point: bounded indexed source and relevant existing knowledge. Reading does not learn or review; learning and maintenance are explicit tools.",
            true,
            object(
                json!({"query":{"type":"string","minLength":1,"description":"Distilled query, at most 4096 UTF-8 bytes"},"limit":{"type":"integer","minimum":1,"maximum":100,"default":5},"knowledge_limit":{"type":"integer","minimum":1,"maximum":20,"default":5},"knowledge":{"type":"string","enum":["auto","off"],"description":"Override local context preference. Default auto consumes relevant existing knowledge; off skips knowledge loading and assessment."},"max_bytes":budget}),
                &["query"],
            ),
        ),
        (
            "maintenance",
            "List pending knowledge or inspect selected complete support and changes. Reads author no events.",
            true,
            object(
                json!({"id":{"type":"string","format":"uuid"},"after":{"type":"string","format":"uuid"},"max_bytes":budget,"evidence":paths,"anchors":anchors,"selector":selector,
                "history":{"type":"boolean","default":false},"history_cursor":{"type":"string","description":"Opaque continuation from maintenance; bound to claim, review and assessment."},"source":string,"view":{"type":"string","enum":["current","recorded","canonical","diff"]},"review":{"type":"string","format":"uuid"},"offset":{"type":"integer","minimum":0},"assessment":assessment,"review_before":{"type":"string","description":"Optional UTC cutoff YYYY-MM-DD"}}),
                &[],
            ),
        ),
    ];
    for (name, description) in [
        (
            "learn",
            "Record an explicitly supplied statement and complete supporting files with actor provenance.",
        ),
        (
            "review",
            "Record review of the unchanged statement and complete support. Reject stale assessment. Promotion is explicit.",
        ),
        (
            "replace",
            "Record a changed statement and supersede its predecessor in one journal batch. Reject stale assessment.",
        ),
    ] {
        let mut properties = json!({"actor":{"type":"string","minLength":1},"actor_kind":{"type":"string","enum":["agent","human","ci","system"],"default":"agent"},"harness":string,"session":string,"evidence":paths,"anchors":anchors});
        let mut required = vec!["actor"];
        if name != "review" {
            properties["statement"] = json!({"type":"string","minLength":1});
            properties["rationale"] = string.clone();
            properties["kind"] = json!({"type":"string","enum":["architecture","decision","invariant","constraint","convention","gotcha","discovery"]});
            required.push("statement");
        }
        if name == "learn" {
            properties["evidence"]["minItems"] = json!(1);
        } else {
            properties["assessment"] = assessment.clone();
            properties["reviewed"] = json!({"type":"boolean","const":true});
            required.extend(["assessment", "reviewed"]);
            properties["evidence"]["minItems"] = json!(1);
        }
        if name == "review" {
            properties["promote"] = json!({"type":"boolean","default":false});
        }
        definitions.push((name, description, false, object(properties, &required)));
    }
    json!({"tools":definitions.into_iter().map(|(name,description,read,schema)|json!({"name":name,"description":description,"inputSchema":schema,
        "annotations":{"readOnlyHint":read,"destructiveHint":false,"idempotentHint":read,"openWorldHint":false}})).collect::<Vec<_>>()})
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ContextArgs {
    knowledge: Option<crate::config::KnowledgeMode>,
    query: String,
    #[serde(default = "five")]
    limit: usize,
    #[serde(default = "five")]
    knowledge_limit: usize,
    #[serde(default = "budget")]
    max_bytes: usize,
}
fn five() -> usize {
    5
}
fn budget() -> usize {
    16000
}

// Validate the small, explicitly advertised schema vocabulary. Reference internals
// and semantic/path/date checks remain in their domain operations.
fn validate(schema: &Value, value: &Value) -> Result<()> {
    let input = value
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("arguments must be an object"))?;
    for field in schema["required"].as_array().unwrap() {
        ensure!(
            input.contains_key(field.as_str().unwrap()),
            "missing required argument {field}"
        );
    }
    for (key, value) in input {
        let rule = schema["properties"]
            .get(key)
            .ok_or_else(|| anyhow::anyhow!("unknown argument {key}"))?;
        let valid = match rule["type"].as_str() {
            Some("string") => value.is_string(),
            Some("integer") => value.is_u64(),
            Some("boolean") => value.is_boolean(),
            Some("object") => value.is_object(),
            Some("array") => value.as_array().is_some_and(|a| {
                a.iter().all(|v| {
                    if rule["items"]["type"] == "object" {
                        validate(&rule["items"], v).is_ok()
                    } else {
                        v.is_string()
                    }
                })
            }),
            _ => false,
        };
        ensure!(valid, "invalid type for {key}");
        if value.is_object() && rule["properties"].is_object() {
            validate(rule, value)?;
        }
        if let Some(choices) = rule["enum"].as_array() {
            ensure!(choices.contains(value), "unsupported value for {key}");
        }
        if let Some(required) = rule.get("const") {
            ensure!(value == required, "{key} must be {required}");
        }
        if let Some(n) = value.as_u64() {
            ensure!(
                rule["minimum"].as_u64().is_none_or(|min| n >= min)
                    && rule["maximum"].as_u64().is_none_or(|max| n <= max),
                "{key} is out of range"
            );
        }
        if let Some(a) = value.as_array() {
            ensure!(
                rule["minItems"]
                    .as_u64()
                    .is_none_or(|n| a.len() >= n as usize),
                "{key} must not be empty"
            );
        }
        if let Some(s) = value.as_str() {
            ensure!(
                rule["minLength"]
                    .as_u64()
                    .is_none_or(|n| s.chars().count() >= n as usize),
                "{key} must not be empty"
            );
        }
    }
    Ok(())
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WriteArgs {
    actor: String,
    actor_kind: Option<String>,
    harness: Option<String>,
    session: Option<String>,
    statement: Option<String>,
    rationale: Option<String>,
    kind: Option<String>,
    evidence: Option<Vec<String>>,
    anchors: Option<Vec<Spec>>,
    assessment: Option<Value>,
    reviewed: Option<bool>,
    promote: Option<bool>,
}

pub fn call(
    options: &Options,
    retriever: &mut Retriever,
    name: &str,
    arguments: Value,
    make_embedder: impl FnOnce() -> Result<embedding::Embedder>,
) -> Result<Value> {
    let mut activity = matches!(name, "learn" | "review" | "replace")
        .then(|| crate::status::Activity::start(&options.root, name, "knowledge"));
    if let Some(activity) = &mut activity {
        activity.target(Some(knowledge::settings::diagnostic_target(
            &options.root,
            options.state.as_deref(),
            options
                .repository
                .as_ref()
                .map(|id| RepositoryId(id.clone()))
                .as_ref(),
            options.default_branch.as_deref(),
        )));
        activity.target_claim(
            crate::input::parse_reference(arguments["assessment"].clone())
                .ok()
                .map(|r| r.knowledge.0.to_string())
                .as_deref(),
        );
    }
    let preview = arguments["statement"].as_str().map(str::to_owned);
    let result = call_inner(
        options,
        retriever,
        name,
        arguments,
        make_embedder,
        activity.as_mut(),
    );
    if let Some(activity) = &mut activity {
        match &result {
            Ok(value) => activity.finish(
                "success",
                None,
                value["knowledge_id"].as_str(),
                preview.as_deref(),
            ),
            Err(error) => activity.finish("failure", Some(&error.to_string()), None, None),
        }
    }
    result
}
fn call_inner(
    options: &Options,
    retriever: &mut Retriever,
    name: &str,
    arguments: Value,
    make_embedder: impl FnOnce() -> Result<embedding::Embedder>,
    activity: Option<&mut crate::status::Activity>,
) -> Result<Value> {
    let definitions = list();
    let definition = definitions["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == name)
        .ok_or_else(|| anyhow::anyhow!("unknown tool"))?;
    validate(&definition["inputSchema"], &arguments)?;
    if name == "context" {
        let args: ContextArgs = serde_json::from_value(arguments)?;
        ensure!(
            args.max_bytes <= MAX_BYTES,
            "max_bytes must not exceed {MAX_BYTES}"
        );
        return task::execute(
            &task::Request {
                root: &options.root,
                query: &args.query,
                knowledge: args.knowledge,
                source_limit: args.limit,
                knowledge_limit: args.knowledge_limit,
                max_bytes: args.max_bytes,
                repository: options.repository.as_deref(),
                state: options.state.as_deref(),
                default_branch: options.default_branch.as_deref(),
            },
            retriever,
            make_embedder,
        );
    }
    let settings = knowledge::settings::resolve(
        &options.root,
        options.repository.as_deref(),
        options.default_branch.as_deref(),
        None,
    )?;
    if let Some(activity) = activity {
        activity.target(Some(knowledge::settings::diagnostic_target(
            &options.root,
            options.state.as_deref(),
            settings.repository.as_ref(),
            Some(&settings.default_branch),
        )));
    }
    let repository = settings.repository.ok_or_else(|| {
        anyhow::anyhow!("run knowledge setup --repository ID or launch with --repository")
    })?;
    let state = options
        .state
        .clone()
        .unwrap_or_else(|| options.root.join(".mimirs/knowledge"));
    let checkout = Checkout::open(&options.root, &repository)?
        .with_default_branch(&settings.default_branch)?;
    if name == "maintenance" {
        let args = crate::input::maintenance(arguments)?;
        ensure!(
            args.max_bytes <= MAX_BYTES,
            "max_bytes must not exceed {MAX_BYTES}"
        );
        return maintenance::read_request(
            &checkout,
            &knowledge::read_events(&state, &repository)?,
            &args,
        );
    }
    ensure!(NAMES.contains(&name), "unknown tool");
    let args: WriteArgs = serde_json::from_value(arguments)?;
    use clap::ValueEnum;
    let actor = Actor {
        id: args.actor,
        kind: ActorKind::from_str(args.actor_kind.as_deref().unwrap_or("agent"), false)
            .map_err(anyhow::Error::msg)?,
        harness: args.harness,
        session: args.session,
    };
    let kind = args
        .kind
        .map(|k| KnowledgeKind::from_str(&k, false).map_err(anyhow::Error::msg))
        .transpose()?;
    if let Some(paths) = &args.evidence {
        ensure!(
            !paths.is_empty(),
            "explicit complete evidence must not be empty"
        );
    }
    let mut store = Store::open(&state, &repository)?;
    if name == "learn" {
        let statement = args.statement.as_deref().ok_or_else(|| {
            anyhow::anyhow!(if args.anchors.is_none() {
                "statement is required"
            } else {
                "statement required"
            })
        })?;
        let selected = if args.anchors.is_none() {
            None
        } else {
            Some(evidence::inputs(
                args.evidence.as_deref().unwrap_or(&[]),
                args.anchors.as_deref().unwrap_or(&[]),
            )?)
        };
        let support = match selected.as_deref() {
            Some(selected) => Support::Selected(selected),
            None => Support::Paths(
                args.evidence
                    .as_deref()
                    .ok_or_else(|| anyhow::anyhow!("complete evidence is required"))?,
            ),
        };
        return Ok(serde_json::to_value(store.write(
            &checkout,
            &actor,
            KnowledgeWrite::Learn {
                kind: kind.unwrap_or(KnowledgeKind::Discovery),
                statement,
                rationale: args.rationale,
                support,
            },
        )?)?);
    }
    let confirmation = Reviewed::confirm(args.reviewed == Some(true)).ok_or_else(|| anyhow::anyhow!(
        "reviewed must explicitly be true after reviewing the statement and complete supporting set"
    ))?;

    let reference = crate::input::parse_reference(
        args.assessment
            .ok_or_else(|| anyhow::anyhow!("assessment is required"))?,
    )?;
    let selected = if args.anchors.is_some() || args.evidence.is_some() {
        Some(evidence::inputs(
            args.evidence.as_deref().unwrap_or(&[]),
            args.anchors.as_deref().unwrap_or(&[]),
        )?)
    } else {
        None
    };
    let operation = if name == "review" {
        KnowledgeWrite::Review {
            confirmation,
            assessment: &reference,
            support: selected.as_deref().map(Support::Selected),
            promote: args.promote.unwrap_or(false),
        }
    } else {
        KnowledgeWrite::Replace {
            confirmation,
            request: ReplacementRequest {
                support: selected.as_deref(),
                assessment: &reference,
                statement: args
                    .statement
                    .as_deref()
                    .ok_or_else(|| anyhow::anyhow!("statement is required"))?,
                rationale: args.rationale,
                kind,
                paths: args.evidence.as_deref(),
            },
        }
    };
    Ok(serde_json::to_value(
        store.write(&checkout, &actor, operation)?,
    )?)
}
