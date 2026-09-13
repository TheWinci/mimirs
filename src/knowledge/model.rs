use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use uuid::Uuid;

macro_rules! identity {
    ($name:ident) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(pub Uuid);
        impl $name {
            pub fn new() -> Self {
                Self(Uuid::now_v7())
            }
        }
    };
}
identity!(EventId);
identity!(KnowledgeId);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct RepositoryId(pub String);
impl RepositoryId {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            !self.0.trim().is_empty() && self.0.len() <= 512,
            "repository ID must contain 1..512 bytes"
        );
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Revision {
    pub repository: RepositoryId,
    pub commit: String,
}
impl Revision {
    pub fn validate(&self, repository: &RepositoryId) -> Result<()> {
        ensure!(
            &self.repository == repository,
            "revision repository mismatch"
        );
        ensure!(
            [40, 64].contains(&self.commit.len())
                && self.commit.bytes().all(|b| b.is_ascii_hexdigit()),
            "revision must be a full Git object ID"
        );
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, clap::ValueEnum)]
pub enum ActorKind {
    Human,
    Agent,
    Ci,
    System,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Actor {
    pub id: String,
    pub kind: ActorKind,
    pub harness: Option<String>,
    pub session: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, clap::ValueEnum)]
pub enum KnowledgeKind {
    Architecture,
    Decision,
    Invariant,
    Constraint,
    Convention,
    Gotcha,
    Discovery,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Claim {
    pub id: KnowledgeId,
    pub kind: KnowledgeKind,
    pub statement: String,
    pub rationale: Option<String>,
    pub scope: Vec<String>,
    pub learned_at: Revision,
    pub branch: Option<String>,
    pub dirty: bool,
    pub provisional: bool,
    #[serde(default = "default_branch", skip_serializing_if = "is_main")]
    pub default_branch: String,
}

pub fn default_branch() -> String {
    "main".into()
}
fn is_main(branch: &str) -> bool {
    branch == "main"
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Review {
    pub knowledge: KnowledgeId,
    pub revision: Revision,
    pub evidence: Vec<FileEvidence>,
    pub replaces: BTreeSet<EventId>,
    pub promote: bool,
    pub branch: String,
    pub default_branch: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FileEvidence {
    pub path: String,
    pub sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anchor: Option<super::evidence::Anchor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub committed: Option<super::conversion::Committed>,
}

impl FileEvidence {
    pub fn validate(&self) -> Result<()> {
        validate_path(&self.path)?;
        if let Some(committed) = &self.committed {
            committed.validate()?;
        }
        if let Some(anchor) = &self.anchor {
            anchor.selector.validate()?;
            ensure!(!anchor.provider.is_empty(), "anchor provider required");
            ensure!(
                anchor.region_sha256.len() == 64
                    && anchor.region_sha256.bytes().all(|b| b.is_ascii_hexdigit()),
                "invalid anchor region SHA-256"
            );
        }
        ensure!(
            self.sha256.len() == 64 && self.sha256.bytes().all(|b| b.is_ascii_hexdigit()),
            "invalid SHA-256 fingerprint"
        );
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum KnowledgeEvent {
    Reviewed {
        review: Review,
    },
    Created {
        claim: Claim,
    },
    EvidenceAttached {
        knowledge: KnowledgeId,
        evidence: FileEvidence,
    },
    Verified {
        knowledge: KnowledgeId,
        revision: Revision,
        evidence: BTreeSet<EventId>,
    },
    Superseded {
        old: KnowledgeId,
        new: KnowledgeId,
        revision: Revision,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Event {
    pub version: u32,
    pub id: EventId,
    pub repository: RepositoryId,
    pub actor: Actor,
    pub created_at_unix_ms: u64,
    pub payload: KnowledgeEvent,
}
impl Event {
    pub fn new(repository: &RepositoryId, actor: &Actor, payload: KnowledgeEvent) -> Result<Self> {
        let anchored = match &payload {
            KnowledgeEvent::EvidenceAttached { evidence, .. } => evidence.anchor.is_some(),
            KnowledgeEvent::Reviewed { review } => {
                review.evidence.iter().any(|e| e.anchor.is_some())
            }
            _ => false,
        };
        let converted = match &payload {
            KnowledgeEvent::EvidenceAttached { evidence, .. } => evidence.committed.is_some(),
            KnowledgeEvent::Reviewed { review } => {
                review.evidence.iter().any(|e| e.committed.is_some())
            }
            _ => false,
        };
        let event = Self {
            version: if converted {
                4
            } else if anchored {
                3
            } else {
                2
            },
            id: EventId::new(),
            repository: repository.clone(),
            actor: actor.clone(),
            created_at_unix_ms: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)?
                .as_millis()
                .try_into()?,
            payload,
        };
        event.validate(repository)?;
        Ok(event)
    }
    pub fn validate(&self, repository: &RepositoryId) -> Result<()> {
        repository.validate()?;
        ensure!(
            matches!(self.version, 1..=4),
            "unsupported knowledge event version {}",
            self.version
        );
        ensure!(&self.repository == repository, "event repository mismatch");
        ensure!(!self.actor.id.trim().is_empty(), "actor ID is required");
        ensure!(!self.id.0.is_nil(), "event ID cannot be nil");
        match &self.payload {
            KnowledgeEvent::Reviewed { review } => {
                ensure!(
                    self.version >= 2,
                    "reviews require event version 2 or later"
                );
                review.revision.validate(repository)?;
                ensure!(
                    !review.replaces.is_empty(),
                    "review must identify the states it replaces"
                );
                ensure!(
                    !review.evidence.is_empty(),
                    "review requires a complete nonempty evidence set"
                );
                ensure!(
                    !review.default_branch.trim().is_empty()
                        && review.branch == review.default_branch,
                    "review must record its author's default-branch policy"
                );
                let mut paths = BTreeSet::new();
                for evidence in &review.evidence {
                    evidence.validate()?;
                    ensure!(
                        evidence.committed.is_none() || self.version >= 4,
                        "committed identity requires event version 4"
                    );
                    ensure!(
                        evidence.anchor.is_none() || self.version >= 3,
                        "anchors require event version 3 or later"
                    );
                    ensure!(
                        paths.insert(super::evidence::Spec::from_evidence(evidence).identity()),
                        "review has duplicate evidence identities"
                    );
                }
            }
            KnowledgeEvent::Created { claim } => {
                ensure!(
                    !claim.id.0.is_nil() && !claim.statement.trim().is_empty(),
                    "claim ID and statement are required"
                );
                claim.learned_at.validate(repository)?;
                ensure!(
                    !claim.default_branch.trim().is_empty(),
                    "default branch is required"
                );
                ensure!(
                    self.version != 1 || claim.default_branch == "main",
                    "version 1 used the main branch policy"
                );
                ensure!(!claim.scope.is_empty(), "claim scope is required");
                for path in &claim.scope {
                    validate_path(path)?;
                }
                ensure!(
                    !(claim.dirty
                        || claim.branch.as_deref() != Some(claim.default_branch.as_str()))
                        || claim.provisional,
                    "non-default-branch or dirty knowledge must be provisional"
                );
            }
            KnowledgeEvent::EvidenceAttached { evidence, .. } => {
                evidence.validate()?;
                ensure!(
                    evidence.committed.is_none() || self.version >= 4,
                    "committed identity requires event version 4"
                );
                ensure!(
                    evidence.anchor.is_none() || self.version >= 3,
                    "anchors require event version 3 or later"
                );
            }
            KnowledgeEvent::Verified {
                revision, evidence, ..
            } => {
                revision.validate(repository)?;
                ensure!(!evidence.is_empty(), "verification requires evidence");
            }
            KnowledgeEvent::Superseded { old, new, revision } => {
                ensure!(old != new, "a claim cannot supersede itself");
                revision.validate(repository)?;
            }
        }
        Ok(())
    }
}

pub use crate::files::validate_path;
