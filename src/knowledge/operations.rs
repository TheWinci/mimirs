//! Shared explicit writes for CLI and MCP. Transport parsing stays with each adapter.
use super::{
    ReplacementRequest, Store, assessment::maintenance::Reference, checkout::Checkout,
    evidence::Spec, model::*,
};
use anyhow::Result;
use serde::Serialize;

pub struct Reviewed(());
impl Reviewed {
    pub fn confirm(confirmed: bool) -> Option<Self> {
        confirmed.then_some(Self(()))
    }
}

pub enum Support<'a> {
    Paths(&'a [String]),
    Selected(&'a [Spec]),
}
pub enum Write<'a> {
    Learn {
        kind: KnowledgeKind,
        statement: &'a str,
        rationale: Option<String>,
        support: Support<'a>,
    },
    Review {
        confirmation: Reviewed,
        assessment: &'a Reference,
        support: Option<Support<'a>>,
        promote: bool,
    },
    Replace {
        confirmation: Reviewed,
        request: ReplacementRequest<'a>,
    },
}
#[derive(Serialize)]
#[serde(untagged)]
pub enum Written {
    Learned {
        knowledge_id: KnowledgeId,
    },
    Reviewed {
        knowledge_id: KnowledgeId,
        review_event: EventId,
        promotion_requested: bool,
    },
    Replaced {
        knowledge_id: KnowledgeId,
        superseded: KnowledgeId,
        atomic_batch: bool,
    },
}
impl Store {
    pub fn write(
        &mut self,
        checkout: &Checkout,
        actor: &Actor,
        operation: Write<'_>,
    ) -> Result<Written> {
        Ok(match operation {
            Write::Learn {
                kind,
                statement,
                rationale,
                support,
            } => {
                let knowledge_id = match support {
                    Support::Paths(paths) => {
                        self.learn(checkout, actor, kind, statement, rationale, paths)?
                    }
                    Support::Selected(support) => self.learn_with_evidence(
                        checkout, actor, kind, statement, rationale, support,
                    )?,
                };
                Written::Learned { knowledge_id }
            }
            Write::Review {
                confirmation: Reviewed(()),
                assessment,
                support,
                promote,
            } => {
                let review_event = match support {
                    Some(Support::Paths(paths)) => {
                        self.review_assessed(checkout, actor, assessment, Some(paths), promote)?
                    }
                    Some(Support::Selected(support)) => self.review_assessed_with_evidence(
                        checkout,
                        actor,
                        assessment,
                        Some(support),
                        promote,
                    )?,
                    None => self.review_assessed_with_evidence(
                        checkout, actor, assessment, None, promote,
                    )?,
                };
                Written::Reviewed {
                    knowledge_id: assessment.knowledge,
                    review_event,
                    promotion_requested: promote,
                }
            }
            Write::Replace {
                confirmation: Reviewed(()),
                request,
            } => {
                let superseded = request.assessment.knowledge;
                let knowledge_id = self.replace_assessed(checkout, actor, request)?;
                Written::Replaced {
                    knowledge_id,
                    superseded,
                    atomic_batch: true,
                }
            }
        })
    }
}
