//! Current processing limitations. Detailed entries stay outside status.json.
use super::scan::{Content, Scan};
use crate::{files::cache::persist, storage};
use anyhow::Result;
use serde::Serialize;
use std::{collections::BTreeSet, path::Path};

pub(crate) const PATH: &str = ".mimirs/watch/diagnostics.json";
const RETAIN: usize = 10_000;
#[derive(Clone, Default, Debug, Serialize)]
pub(crate) struct Counts {
    pub unsupported_encoding_files: usize,
    pub parser_files: usize,
    pub parser_diagnostics: usize,
    pub read_failures: usize,
    pub omitted_details: usize,
}
impl Counts {
    pub fn any(&self) -> bool {
        self.unsupported_encoding_files > 0 || self.parser_diagnostics > 0
    }
}
#[derive(PartialEq, Eq, PartialOrd, Ord, Serialize)]
struct Entry {
    path: String,
    kind: &'static str,
    line: Option<usize>,
    column: Option<usize>,
    bytes: Option<[usize; 2]>,
    reason: String,
}
pub(crate) fn publish(
    root: &Path,
    db: &rusqlite::Connection,
    scan: &Scan,
    errors: &[String],
    counts: &mut Counts,
) -> Result<()> {
    publish_with_limit(root, db, scan, errors, RETAIN, counts)
}
pub(super) fn publish_with_limit(
    root: &Path,
    db: &rusqlite::Connection,
    scan: &Scan,
    errors: &[String],
    limit: usize,
    out_counts: &mut Counts,
) -> Result<()> {
    let mut counts = Counts::default();
    let mut entries = Vec::new();
    for (path, observed) in &scan.files {
        let mut unique = BTreeSet::new();
        if observed.content == Content::UnsupportedEncoding {
            counts.unsupported_encoding_files += 1;
            unique.insert(Entry {
                path: path.clone(),
                kind: "unsupported_encoding",
                line: None,
                column: None,
                bytes: None,
                reason: "not valid UTF-8; source was skipped".into(),
            });
        }
        if let Some(reason) = &observed.error {
            counts.read_failures += 1;
            unique.insert(Entry {
                path: path.clone(),
                kind: "read_failure",
                line: None,
                column: None,
                bytes: None,
                reason: reason.clone(),
            });
        }
        if let Some(saved) = storage::analysis::load(db, path)?
            && observed.hash.as_deref()
                == Some(crate::files::fingerprint(saved.source.text.as_bytes()).as_str())
        {
            for diagnostic in &saved.diagnostics {
                unique.insert(Entry {
                    path: path.clone(),
                    kind: "parser",
                    line: Some(diagnostic.span.line_start),
                    column: Some(diagnostic.column),
                    bytes: Some([diagnostic.span.start, diagnostic.span.end]),
                    reason: diagnostic.kind.clone(),
                });
            }
        }
        let parser_count = unique.iter().filter(|e| e.kind == "parser").count();
        counts.parser_diagnostics += parser_count;
        counts.parser_files += usize::from(parser_count > 0);
        for entry in unique {
            if entries.len() < limit {
                entries.push(entry);
            } else {
                counts.omitted_details += 1;
            }
        }
    }
    *out_counts = counts.clone();
    persist(
        root,
        "diagnostics.json",
        &serde_json::json!({
            "version":1,"inputs":scan.key(),"counts":counts,"entries":entries,"errors":errors,
            "coverage":if errors.is_empty(){"observed_selection"}else{"incomplete_processing"},
            "graph_coverage":if counts.any(){"incomplete"}else if errors.is_empty(){"eligible"}else{"unavailable"},
            "detail_limit":limit,"basis":"last processing observation; indexed parser diagnostics, not a whole-project correctness assessment"
        }),
    )?;
    Ok(())
}
