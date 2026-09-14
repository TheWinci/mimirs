use crate::knowledge::evidence::{self, Selector, Spec};
use crate::knowledge::operations::{Reviewed, Support, Write as KnowledgeWrite};
use crate::{
    knowledge::assessment as context,
    knowledge::{
        ReplacementRequest, Store, checkout::Checkout, model::*, registry::LocalDirectoryRegistry,
    },
};
use anyhow::Result;
use clap::{Args, Subcommand};
use std::{
    io::{self, Write},
    path::PathBuf,
};

/// Experimental evidence-backed knowledge, independent of the search index.
#[derive(Args)]
pub struct Options {
    /// Shared logical identity, for example example/identity. Never a checkout path.
    #[arg(long, global = true)]
    repository: Option<String>,
    /// Policy for local learning and reviews. Historical events retain their own policy.
    #[arg(long, global = true)]
    default_branch: Option<String>,
    /// Git repository root whose current evidence should be read.
    #[arg(long, global = true, default_value = ".")]
    root: PathBuf,
    /// Independent local instance state. Defaults to ROOT/.mimirs/knowledge.
    #[arg(long)]
    state: Option<PathBuf>,
    #[command(subcommand)]
    action: Action,
}
#[derive(Args)]
pub struct Provenance {
    #[arg(long)]
    actor: String,
    #[arg(long, value_enum, default_value = "agent")]
    actor_kind: ActorKind,
    #[arg(long)]
    harness: Option<String>,
    #[arg(long)]
    session: Option<String>,
}
impl Provenance {
    fn actor(self) -> Actor {
        Actor {
            id: self.actor,
            kind: self.actor_kind,
            harness: self.harness,
            session: self.session,
        }
    }
}
#[derive(Args)]
struct Maintenance {
    /// Page historical review states, separately from current support.
    #[arg(long, requires = "knowledge")]
    history: bool,
    /// Continue history with the opaque token returned by maintenance.
    #[arg(long, requires = "knowledge")]
    history_cursor: Option<String>,
    /// Inspect an unchanged or pending claim; omit to list pending work.
    knowledge: Option<uuid::Uuid>,
    #[arg(long)]
    after: Option<uuid::Uuid>,
    /// Optional advisory review-age cutoff at UTC midnight, YYYY-MM-DD.
    #[arg(long, value_parser = context::maintenance::parse_review_before)]
    review_before: Option<u64>,
    #[arg(long, default_value_t = 16000)]
    max_bytes: usize,
    /// Observe additional proposed support before an assessed write.
    #[arg(long, requires = "knowledge")]
    evidence: Vec<String>,
    /// Precise Rust declaration evidence as JSON with path and selector. Repeat for dependencies.
    #[arg(long, value_parser=evidence::parse)]
    anchor: Vec<Spec>,
    /// Page complete support or its exact recorded-to-current diff.
    #[arg(long, requires = "knowledge")]
    source: Option<String>,
    /// Select an anchored region within --source for current, recorded or diff paging.
    #[arg(long, requires="source",value_parser=evidence::parse_selector)]
    selector: Option<Selector>,
    #[arg(long, value_enum, requires = "source")]
    view: Option<context::maintenance::View>,
    #[arg(long, requires = "source")]
    review: Option<uuid::Uuid>,
    #[arg(long, default_value_t = 0)]
    offset: usize,
    /// Require this prior observation to remain valid while reading another page.
    #[arg(long, requires = "knowledge")]
    assessment: Option<PathBuf>,
}

#[derive(Subcommand)]
enum Action {
    /// Set up local knowledge once. Without --repository, create a Git-local identity shared by linked worktrees. Separate clones need an explicit shared --repository.
    Setup {
        #[arg(long)]
        registry: Option<PathBuf>,
    },
    /// List maintenance work or inspect selected evidence without recording a review.
    Maintenance(Box<Maintenance>),
    /// Reaffirm the unchanged statement using a prior maintenance assessment.
    Review {
        #[arg(long)]
        assessment: PathBuf,
        /// Explicit complete new support set. Omit to retain all inspected active support.
        #[arg(long)]
        evidence: Vec<String>,
        /// Precise Rust declaration evidence as JSON with path and selector. Repeat for dependencies.
        #[arg(long, value_parser=evidence::parse)]
        anchor: Vec<Spec>,
        #[arg(long)]
        promote: bool,
        #[arg(long, required = true)]
        reviewed: bool,
        #[command(flatten)]
        provenance: Provenance,
    },
    /// Record a changed statement and supersede its predecessor in one journal batch.
    Replace {
        statement: String,
        #[arg(long)]
        assessment: PathBuf,
        #[arg(long)]
        evidence: Vec<String>,
        /// Precise Rust declaration evidence as JSON with path and selector. Repeat for dependencies.
        #[arg(long, value_parser=evidence::parse)]
        anchor: Vec<Spec>,
        #[arg(long)]
        rationale: Option<String>,
        #[arg(long, value_enum)]
        kind: Option<KnowledgeKind>,
        #[arg(long, required = true)]
        reviewed: bool,
        #[command(flatten)]
        provenance: Provenance,
    },
    /// Record a claim and the actor's verification of its current supporting files.
    Learn {
        statement: String,
        #[arg(long, value_enum, default_value = "discovery")]
        kind: KnowledgeKind,
        #[arg(long)]
        rationale: Option<String>,
        /// Whole-file evidence, relative to repository root. Repeat for more support.
        #[arg(long, required_unless_present = "anchor")]
        evidence: Vec<String>,
        /// Precise Rust declaration evidence as JSON with path and selector. Repeat for dependencies.
        #[arg(long, value_parser=evidence::parse)]
        anchor: Vec<Spec>,
        #[command(flatten)]
        provenance: Provenance,
    },
    /// Publish all missing local events, including provisional claims, to a registry.
    Publish {
        #[arg(long)]
        registry: Option<PathBuf>,
    },
    /// Receive and materialize registry events without copying a database.
    Pull {
        #[arg(long)]
        registry: Option<PathBuf>,
    },
    /// Read pending exchange counts and current local conflicts without publishing or pulling.
    ExchangeStatus {
        #[arg(long)]
        registry: Option<PathBuf>,
    },
    /// Compact live claim summaries. Consuming unchanged knowledge needs no new review.
    Orient {
        /// Continue after this claim ID from next_after. Each page reassesses live source.
        #[arg(long)]
        after: Option<uuid::Uuid>,
        #[arg(long, default_value_t = 16000)]
        max_bytes: usize,
    },
    /// Reassess support in the current working tree; emits the same JSON as orient.
    Reconcile {
        #[arg(long)]
        after: Option<uuid::Uuid>,
        #[arg(long, default_value_t = 16000)]
        max_bytes: usize,
    },
    /// Inspect one claim with live fingerprints, bounded previews and review provenance.
    Show {
        knowledge: uuid::Uuid,
        /// Include immutable projection history, subject to the same output budget.
        #[arg(long)]
        history: bool,
        /// Complete JSON response budget in bytes, including the final newline.
        #[arg(long, default_value_t = 16000)]
        max_bytes: usize,
    },
    /// Preserve both claims and record an explicit revision-scoped replacement.
    Supersede {
        old: uuid::Uuid,
        new: uuid::Uuid,
        #[command(flatten)]
        provenance: Provenance,
    },
    /// Rebuild the disposable SQLite projection from immutable local events.
    Replay,
}

pub fn run(options: Options) -> Result<()> {
    let operation = match &options.action {
        Action::Learn { .. } => "learn",
        Action::Review { .. } => "review",
        Action::Replace { .. } | Action::Supersede { .. } => "replace",
        Action::Setup { .. } => "setup",
        Action::Publish { .. } => "publish",
        Action::Pull { .. } => "pull",
        _ => "knowledge-read",
    };
    let preview = match &options.action {
        Action::Learn { statement, .. } | Action::Replace { statement, .. } => {
            Some(statement.clone())
        }
        _ => None,
    };
    // Read assessed input once, before execution, and use that same reference for the write.
    let reference = match &options.action {
        Action::Review { assessment, .. } | Action::Replace { assessment, .. } => {
            Some(crate::input::read_reference(assessment))
        }
        _ => None,
    };
    let mut activity = crate::status::Activity::start(&options.root, operation, "knowledge");
    activity.target(Some(crate::knowledge::settings::diagnostic_target(
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
        reference
            .as_ref()
            .and_then(|r| r.as_ref().ok())
            .map(|r| r.knowledge.0.to_string())
            .as_deref(),
    );
    let result = run_value(options, reference, &mut activity);
    match &result {
        Ok(value) => activity.finish(
            "success",
            None,
            value["knowledge_id"].as_str(),
            preview.as_deref(),
        ),
        Err(error) => activity.finish("failure", Some(&error.to_string()), None, None),
    }
    writeln!(io::stdout().lock(), "{}", serde_json::to_string(&result?)?)?;
    Ok(())
}
fn run_value(
    options: Options,
    reference: Option<Result<context::maintenance::Reference>>,
    activity: &mut crate::status::Activity,
) -> Result<serde_json::Value> {
    if let Action::Setup { registry } = &options.action {
        let value = crate::knowledge::settings::setup(
            &options.root,
            options.repository.as_deref(),
            options.default_branch.as_deref(),
            registry.as_deref(),
        )?;
        return Ok(value);
    }
    let settings = crate::knowledge::settings::resolve(
        &options.root,
        options.repository.as_deref(),
        options.default_branch.as_deref(),
        None,
    )?;
    activity.target(Some(crate::knowledge::settings::diagnostic_target(
        &options.root,
        options.state.as_deref(),
        settings.repository.as_ref(),
        Some(&settings.default_branch),
    )));
    let repository = settings.repository.ok_or_else(|| {
        anyhow::anyhow!(
            "run mimirs knowledge setup once, or supply --repository for a shared identity"
        )
    })?;
    let state = options
        .state
        .unwrap_or_else(|| options.root.join(".mimirs/knowledge"));
    let mut store = Store::open(&state, &repository)?;
    let output = match options.action {
        Action::Setup { .. } => unreachable!(),
        Action::Maintenance(request) => {
            let checkout = Checkout::open(&options.root, &repository)?
                .with_default_branch(&settings.default_branch)?;
            let events = store.events()?;
            context::maintenance::read_request(
                &checkout,
                &events,
                &context::maintenance::ReadRequest {
                    anchors: request.anchor,
                    history: request.history,
                    history_cursor: request.history_cursor,
                    selector: request.selector,
                    id: request.knowledge.map(KnowledgeId),
                    after: request.after.map(KnowledgeId),
                    max_bytes: request.max_bytes,
                    evidence: request.evidence,
                    source: request.source,
                    view: request.view,
                    review: request.review.map(EventId),
                    offset: request.offset,
                    review_before: request.review_before,
                    assessment: request
                        .assessment
                        .map(|p| crate::input::read_reference(&p))
                        .transpose()?,
                },
            )?
        }

        Action::Review {
            assessment: _,
            evidence,
            anchor,
            promote,
            reviewed,
            provenance,
        } => {
            let confirmation = Reviewed::confirm(reviewed).ok_or_else(|| anyhow::anyhow!("--reviewed must assert review of the unchanged statement and complete supporting set"))?;
            let reference = reference.expect("assessed action captures its reference")?;
            let checkout = Checkout::open(&options.root, &repository)?
                .with_default_branch(&settings.default_branch)?;
            let selected = evidence::inputs(&evidence, &anchor)?;
            let support = if anchor.is_empty() {
                (!evidence.is_empty()).then_some(Support::Paths(evidence.as_slice()))
            } else {
                Some(Support::Selected(&selected))
            };
            serde_json::to_value(store.write(
                &checkout,
                &provenance.actor(),
                KnowledgeWrite::Review {
                    confirmation,
                    assessment: &reference,
                    support,
                    promote,
                },
            )?)?
        }
        Action::Replace {
            statement,
            assessment: _,
            evidence,
            anchor,
            rationale,
            kind,
            reviewed,
            provenance,
        } => {
            let confirmation = Reviewed::confirm(reviewed).ok_or_else(|| anyhow::anyhow!("--reviewed must assert review of the replacement statement and complete supporting set"))?;
            let reference = reference.expect("assessed action captures its reference")?;
            let checkout = Checkout::open(&options.root, &repository)?
                .with_default_branch(&settings.default_branch)?;
            let selected = evidence::inputs(&evidence, &anchor)?;
            serde_json::to_value(store.write(
                &checkout,
                &provenance.actor(),
                KnowledgeWrite::Replace {
                    confirmation,
                    request: ReplacementRequest {
                        support: (!selected.is_empty()).then_some(selected.as_slice()),
                        assessment: &reference,
                        statement: &statement,
                        rationale,
                        kind,
                        paths: (!evidence.is_empty()).then_some(evidence.as_slice()),
                    },
                },
            )?)?
        }
        Action::Learn {
            statement,
            kind,
            rationale,
            evidence,
            anchor,
            provenance,
        } => {
            let checkout = Checkout::open(&options.root, &repository)?
                .with_default_branch(&settings.default_branch)?;
            let selected = if anchor.is_empty() {
                None
            } else {
                Some(evidence::inputs(&evidence, &anchor)?)
            };
            let support = selected
                .as_deref()
                .map(Support::Selected)
                .unwrap_or(Support::Paths(&evidence));
            serde_json::to_value(store.write(
                &checkout,
                &provenance.actor(),
                KnowledgeWrite::Learn {
                    kind,
                    statement: &statement,
                    rationale,
                    support,
                },
            )?)?
        }
        Action::Publish { registry } => {
            let registry = registry
                .or_else(|| settings.registry.clone())
                .ok_or_else(|| {
                    anyhow::anyhow!("supply --registry or configure it with knowledge setup")
                })?;
            serde_json::json!({ "published_events": store.publish(&LocalDirectoryRegistry::new(&registry, &repository))? })
        }
        Action::Pull { registry } => {
            let registry = registry
                .or_else(|| settings.registry.clone())
                .ok_or_else(|| {
                    anyhow::anyhow!("supply --registry or configure it with knowledge setup")
                })?;
            serde_json::json!({ "received_events": store.pull(&LocalDirectoryRegistry::new(&registry, &repository))? })
        }
        Action::ExchangeStatus { registry } => {
            use crate::knowledge::{projection, registry::Registry};
            let registry = registry
                .or_else(|| settings.registry.clone())
                .ok_or_else(|| {
                    anyhow::anyhow!("supply --registry or configure it with knowledge setup")
                })?;
            let local = store.events()?;
            let remote = projection::union(
                &repository,
                LocalDirectoryRegistry::new(&registry, &repository).events()?,
            )?;
            projection::reduce(&projection::union(
                &repository,
                local.values().chain(remote.values()).cloned(),
            )?)?;
            let checkout = Checkout::open(&options.root, &repository)?
                .with_default_branch(&settings.default_branch)?;
            serde_json::json!({"repository":repository,"registry":registry,
                "pending_publish":local.keys().filter(|id|!remote.contains_key(id)).count(),
                "pending_pull":remote.keys().filter(|id|!local.contains_key(id)).count(),
                "local_conflicts":context::conflict_counts(&checkout,&projection::reduce(&local)?)?})
        }
        Action::Replay => serde_json::json!({ "materialized_claims": store.replay()?.len() }),
        Action::Orient { max_bytes, after } | Action::Reconcile { max_bytes, after } => {
            let checkout = Checkout::open(&options.root, &repository)?
                .with_default_branch(&settings.default_branch)?;
            context::orient(
                &checkout,
                &store.replay()?,
                max_bytes,
                after.map(KnowledgeId),
            )?
        }
        Action::Show {
            knowledge,
            max_bytes,
            history,
        } => {
            let checkout = Checkout::open(&options.root, &repository)?
                .with_default_branch(&settings.default_branch)?;
            context::show(
                &checkout,
                &store.replay()?,
                KnowledgeId(knowledge),
                max_bytes,
                history,
            )?
        }
        Action::Supersede {
            old,
            new,
            provenance,
        } => {
            let checkout = Checkout::open(&options.root, &repository)?
                .with_default_branch(&settings.default_branch)?;
            store.supersede(
                &checkout,
                &provenance.actor(),
                KnowledgeId(old),
                KnowledgeId(new),
            )?;
            serde_json::json!({ "superseded": old, "replacement": new })
        }
    };
    Ok(output)
}
