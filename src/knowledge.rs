//! Learned assertions have an immutable journal independent of rebuildable search.
pub(crate) mod assessment;
pub(crate) mod checkout;
pub(crate) mod conversion;
pub(crate) mod evidence;
mod journal;
mod maintenance;
pub(crate) mod model;
pub(crate) mod observation;
pub(crate) mod operations;
pub(crate) mod projection;
pub(crate) mod registry;
pub(crate) mod reviews;
pub(crate) mod settings;
pub use maintenance::ReplacementRequest;

use anyhow::{Result, ensure};
use model::*;
use projection::Knowledge;
use registry::Registry;
use rusqlite::{Connection, TransactionBehavior, params};
use std::{collections::BTreeMap, fs, path::Path, time::Duration};

pub use crate::files::fingerprint;

/// Read immutable events without opening or materializing the disposable projection.
pub fn read_events(state: &Path, repository: &RepositoryId) -> Result<BTreeMap<EventId, Event>> {
    repository.validate()?;
    journal::Journal::new(
        state
            .join("repositories")
            .join(fingerprint(repository.0.as_bytes()))
            .join("events"),
        repository,
    )
    .read()
}

pub struct ReviewRequest<'a> {
    pub knowledge: KnowledgeId,
    pub replaces: std::collections::BTreeSet<EventId>,
    pub paths: &'a [String],
    pub promote: bool,
}

pub struct Store {
    repository: RepositoryId,
    journal: journal::Journal,
    connection: Connection,
}
impl Store {
    pub fn open(state: &Path, repository: &RepositoryId) -> Result<Self> {
        repository.validate()?;
        let directory = state
            .join("repositories")
            .join(fingerprint(repository.0.as_bytes()));
        fs::create_dir_all(&directory)?;
        let mut connection = Connection::open(directory.join("knowledge.sqlite"))?;
        connection.busy_timeout(Duration::from_secs(10))?;
        let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let version: u32 = tx.pragma_query_value(None, "user_version", |r| r.get(0))?;
        ensure!(
            version <= 2,
            "unsupported knowledge projection version {version}; journal preserved"
        );
        if version == 0 {
            let tables: i64 = tx.query_row(
                "SELECT count(*) FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
                [],
                |r| r.get(0),
            )?;
            ensure!(
                tables == 0,
                "unrecognized knowledge database; journal preserved"
            );
            tx.execute_batch("CREATE TABLE repository (id TEXT PRIMARY KEY); CREATE TABLE knowledge (id TEXT PRIMARY KEY, payload TEXT NOT NULL); CREATE TABLE event_log (id TEXT PRIMARY KEY, payload TEXT NOT NULL); PRAGMA user_version = 2;")?;
            tx.execute("INSERT INTO repository VALUES (?1)", [&repository.0])?;
        }
        let stored: String = tx.query_row("SELECT id FROM repository", [], |r| r.get(0))?;
        ensure!(stored == repository.0, "projection repository mismatch");
        tx.commit()?;
        Ok(Self {
            repository: repository.clone(),
            journal: journal::Journal::new(directory.join("events"), repository),
            connection,
        })
    }
    /// Lock before reading files; concurrent refreshes cannot publish an older projection last.
    pub fn replay(&mut self) -> Result<BTreeMap<KnowledgeId, Knowledge>> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let events = self.journal.read()?;
        let claims = projection::reduce(&events)?;
        tx.execute_batch("DELETE FROM knowledge; DELETE FROM event_log;")?;
        for event in events.values() {
            tx.execute(
                "INSERT INTO event_log VALUES (?1, ?2)",
                params![event.id.0.to_string(), serde_json::to_string(event)?],
            )?;
        }
        for knowledge in claims.values() {
            tx.execute(
                "INSERT INTO knowledge VALUES (?1, ?2)",
                params![
                    knowledge.claim.id.0.to_string(),
                    serde_json::to_string(knowledge)?
                ],
            )?;
        }
        // Exercise the materialized read path instead of serving the reducer's in-memory result.
        let materialized = {
            let mut statement = tx.prepare("SELECT payload FROM knowledge ORDER BY id")?;
            let rows = statement.query_map([], |r| r.get::<_, String>(0))?;
            let mut result = BTreeMap::new();
            for row in rows {
                let knowledge: Knowledge = serde_json::from_str(&row?)?;
                result.insert(knowledge.claim.id, knowledge);
            }
            result
        };
        tx.pragma_update(None, "user_version", 2)?;
        tx.commit()?;
        Ok(materialized)
    }
    pub fn append(&mut self, events: &[Event]) -> Result<usize> {
        let count = self.journal.append(events)?;
        self.replay()?;
        Ok(count)
    }
    /// Read immutable events without materializing or authoring semantic state.
    pub fn events(&self) -> Result<BTreeMap<EventId, Event>> {
        self.journal.read()
    }

    pub fn publish(&self, registry: &dyn Registry) -> Result<usize> {
        registry.publish(&self.journal.read()?.into_values().collect::<Vec<_>>())
    }
    pub fn pull(&mut self, registry: &dyn Registry) -> Result<usize> {
        self.append(&registry.events()?)
    }

    pub fn learn(
        &mut self,
        checkout: &checkout::Checkout,
        actor: &Actor,
        kind: KnowledgeKind,
        statement: &str,
        rationale: Option<String>,
        paths: &[String],
    ) -> Result<KnowledgeId> {
        let (id, events) = learning_events(
            &self.repository,
            checkout,
            actor,
            kind,
            statement,
            rationale,
            paths,
        )?;
        self.append(&events)?;
        Ok(id)
    }
    pub fn learn_with_evidence(
        &mut self,
        checkout: &checkout::Checkout,
        actor: &Actor,
        kind: KnowledgeKind,
        statement: &str,
        rationale: Option<String>,
        specs: &[evidence::Spec],
    ) -> Result<KnowledgeId> {
        let (id, events) = learning_events_typed(
            &self.repository,
            checkout,
            actor,
            kind,
            statement,
            rationale,
            specs,
        )?;
        self.append(&events)?;
        Ok(id)
    }
    /// The caller explicitly asserts that the unchanged statement and complete
    /// supporting set have been reviewed. A stale expected frontier is rejected.
    #[cfg(test)]
    pub fn review(
        &mut self,
        checkout: &checkout::Checkout,
        actor: &Actor,
        request: ReviewRequest<'_>,
    ) -> Result<EventId> {
        let (_, id) = self.journal.append_checked(|events| {
            let claims = projection::reduce(events)?;
            let event = review_event(&self.repository, checkout, actor, &claims, request)?;
            let id = event.id;
            Ok((vec![event], id))
        })?;
        self.replay()?;
        Ok(id)
    }

    pub fn supersede(
        &mut self,
        checkout: &checkout::Checkout,
        actor: &Actor,
        old: KnowledgeId,
        new: KnowledgeId,
    ) -> Result<()> {
        ensure!(
            !checkout.dirty()?,
            "supersession requires a clean checkout; commit source changes first"
        );
        checkout.ensure_head()?;
        self.journal.append_checked(|events| {
            let claims = projection::reduce(events)?;
            for id in [old, new] {
                let claim = claims.get(&id).ok_or_else(|| anyhow::anyhow!("unknown knowledge ID"))?;
                ensure!(checkout.ancestry(&claim.claim.learned_at, &checkout.revision)? == checkout::Ancestry::Ancestor,
                    "supersession requires both claim source revisions to be ancestors of its authored revision; ancestry is invalid or unavailable");
            }
            checkout.ensure_head()?;
            Ok((vec![Event::new(&self.repository, actor, KnowledgeEvent::Superseded {
                old, new, revision: checkout.revision.clone(),
            })?], ()))
        })?;
        self.replay()?;
        Ok(())
    }
}

fn learning_events(
    repository: &RepositoryId,
    checkout: &checkout::Checkout,
    actor: &Actor,
    kind: KnowledgeKind,
    statement: &str,
    rationale: Option<String>,
    paths: &[String],
) -> Result<(KnowledgeId, Vec<Event>)> {
    learning_events_typed(
        repository,
        checkout,
        actor,
        kind,
        statement,
        rationale,
        &paths
            .iter()
            .map(|p| evidence::Spec::file(p))
            .collect::<Vec<_>>(),
    )
}
fn learning_events_typed(
    repository: &RepositoryId,
    checkout: &checkout::Checkout,
    actor: &Actor,
    kind: KnowledgeKind,
    statement: &str,
    rationale: Option<String>,
    specs: &[evidence::Spec],
) -> Result<(KnowledgeId, Vec<Event>)> {
    let evidence = evidence::capture_set(checkout, specs)?;
    let unique = evidence
        .iter()
        .map(|e| e.path.clone())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    let mut dirty = checkout.dirty()?;
    for support in &evidence {
        dirty |= !checkout.committed_support(support)?;
    }
    checkout.ensure_head()?;
    let id = KnowledgeId::new();
    let mut events = vec![Event::new(
        repository,
        actor,
        KnowledgeEvent::Created {
            claim: Claim {
                id,
                kind,
                statement: statement.into(),
                rationale,
                scope: unique,
                learned_at: checkout.revision.clone(),
                branch: checkout.branch.clone(),
                dirty,
                provisional: dirty
                    || checkout.branch.as_deref() != Some(checkout.default_branch.as_str()),
                default_branch: checkout.default_branch.clone(),
            },
        },
    )?];
    let mut attached = std::collections::BTreeSet::new();
    for evidence in evidence {
        let event = Event::new(
            repository,
            actor,
            KnowledgeEvent::EvidenceAttached {
                knowledge: id,
                evidence,
            },
        )?;
        attached.insert(event.id);
        events.push(event);
    }
    events.push(Event::new(
        repository,
        actor,
        KnowledgeEvent::Verified {
            knowledge: id,
            revision: checkout.revision.clone(),
            evidence: attached,
        },
    )?);
    Ok((id, events))
}

#[cfg(test)]
fn review_event(
    repository: &RepositoryId,
    checkout: &checkout::Checkout,
    actor: &Actor,
    claims: &BTreeMap<KnowledgeId, Knowledge>,
    request: ReviewRequest<'_>,
) -> Result<Event> {
    review_event_typed(repository, checkout, actor, claims, request, None)
}
fn review_event_typed(
    repository: &RepositoryId,
    checkout: &checkout::Checkout,
    actor: &Actor,
    claims: &BTreeMap<KnowledgeId, Knowledge>,
    request: ReviewRequest<'_>,
    specs: Option<&[evidence::Spec]>,
) -> Result<Event> {
    ensure!(
        checkout.branch.as_deref() == Some(checkout.default_branch.as_str()),
        "review requires the configured default branch '{}'; switch branches or set --default-branch",
        checkout.default_branch
    );
    ensure!(
        !checkout.dirty()?,
        "review requires a clean checkout; commit or discard changes before reviewing"
    );
    let claim = claims
        .get(&request.knowledge)
        .ok_or_else(|| anyhow::anyhow!("unknown knowledge ID"))?;
    ensure!(
        checkout.contains(&claim.claim.learned_at)?,
        "learned revision is not an ancestor of this checkout; obtain or merge the relevant Git history separately"
    );
    let active = reviews::active(checkout, claim)?;
    ensure!(
        active.invalid.is_empty(),
        "review history has inconsistent or unavailable ancestry; obtain the relevant Git history before reviewing"
    );
    ensure!(
        !request.replaces.is_empty() && request.replaces == active.ids(),
        "review must replace every current review head, including conflicts; inspect with maintenance and review again"
    );
    let fallback = request
        .paths
        .iter()
        .map(|p| evidence::Spec::file(p))
        .collect::<Vec<_>>();
    let evidence = evidence::capture_set(checkout, specs.unwrap_or(&fallback))?;
    for support in &evidence {
        ensure!(
            checkout.committed_support(support)?,
            "review evidence '{}' is uncommitted or differs from its committed source; commit it before reviewing",
            support.path
        );
    }
    ensure!(
        !checkout.dirty()?,
        "checkout became dirty while reviewing; retry after committing changes"
    );
    checkout.ensure_head()?;
    let event = Event::new(
        repository,
        actor,
        KnowledgeEvent::Reviewed {
            review: Review {
                knowledge: request.knowledge,
                revision: checkout.revision.clone(),
                evidence,
                replaces: request.replaces,
                promote: request.promote,
                branch: checkout.default_branch.clone(),
                default_branch: checkout.default_branch.clone(),
            },
        },
    )?;
    Ok(event)
}

#[cfg(test)]
#[path = "../tests/unit/knowledge.rs"]
mod tests;
