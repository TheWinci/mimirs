//! Search representations and citations derived from source analysis.
pub(crate) mod compact;
pub(crate) mod query;
use crate::analysis::Span;
pub use crate::analysis::structure::Record;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Evidence {
    pub record: Record,
    pub span: Span,
}

pub(crate) mod split;

// Original q8 construction stays only for frozen baseline fixtures.
#[cfg(test)]
pub(crate) mod source;

pub(crate) mod ts_v2;
