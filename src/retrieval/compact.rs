//! Compact presentation of existing retrieval evidence. Selection follows the audited experiment.
use std::{collections::HashSet, fmt::Write};

use anyhow::{Context, Result, ensure};
use rusqlite::Connection;
#[cfg(test)]
use serde_json::Value;
use serde_json::json;

use crate::{
    analysis::{Analysis, LineIndex, Span},
    storage::{
        self,
        candidates::Candidate,
        hybrid::{FileResult, Response, SourceBlock},
    },
};

pub const MAX_BYTES: usize = 16_000;
const MAX_PRIMARY: usize = 5;

#[cfg(test)]
fn candidate(c: &Candidate) -> Value {
    json!({"id":c.id,"file_id":c.file_id,"path":c.path,"ordinal":c.ordinal,
        "source_chunk":c.source_chunk,"owner":c.owner,"start":c.start,"end":c.end,
        "score":c.score(),"semantic_score":c.semantic_score,"lexical_score":c.lexical_score,
        "semantic_rank":c.semantic_rank,"lexical_rank":c.lexical_rank})
}

/// Identical metadata in both modes, before any evidence selection or packing.
#[cfg(test)]
pub(crate) fn parity(results: &Response) -> Value {
    fn file(f: &FileResult) -> Value {
        json!({"path":f.hit.representative.path,"score":f.hit.score,
            "semantic_score":f.hit.semantic_score,"lexical_score":f.hit.lexical_score,
            "representative":candidate(&f.hit.representative),"snapshot":f.snapshot_hash,
            "windows":f.hit.windows.iter().map(candidate).collect::<Vec<_>>(),
            "blocks":f.blocks.iter().map(|b| json!({"candidate":candidate(&b.document),
                "part":b.part,"evidence":b.evidence,
                "text_hash":storage::processing::source_hash(&b.text)})).collect::<Vec<_>>()})
    }
    json!({"source":results.source.iter().map(file).collect::<Vec<_>>(),
        "docs":results.docs.iter().map(file).collect::<Vec<_>>(),"relations":results.relations})
}

fn representative(file: &FileResult) -> Result<&SourceBlock> {
    file.blocks
        .iter()
        .find(|b| b.document.id == file.hit.representative.id)
        .context("representative candidate has no returned evidence")
}

fn navigation(out: &mut String, category: &str, rank: usize, file: &FileResult) -> Result<()> {
    let block = representative(file)?;
    let first = block
        .evidence
        .first()
        .context("empty representative evidence")?;
    let last = block.evidence.last().unwrap();
    writeln!(
        out,
        "{category} {}: {}",
        rank + 1,
        json!({
            "path":file.hit.representative.path,"score":file.hit.score,
            "candidate":file.hit.representative.id,"snapshot":file.snapshot_hash,
            "navigation_bytes":[first.span.start,last.span.end],
            "navigation_lines":[first.span.line_start,last.span.line_end]
        })
    )?;
    Ok(())
}

fn eligible(kind: &str) -> bool {
    matches!(
        kind,
        "function"
            | "method"
            | "variable"
            | "constant"
            | "field"
            | "property"
            | "type"
            | "macro"
            | "import"
            | "export"
            | "initializer"
            | "event"
            | "delegate"
            | "directive"
            | "given"
    )
}

// Internal syntax segmentation does not turn a callable into a container.
fn nested_declaration(kind: &str, name: Option<&str>) -> bool {
    name.is_some()
        && matches!(
            kind,
            "function"
                | "method"
                | "class"
                | "interface"
                | "struct"
                | "trait"
                | "impl"
                | "module"
                | "type"
                | "enum"
                | "record"
                | "annotation_type"
        )
}

fn callable(kind: &str) -> bool {
    matches!(kind, "function" | "method")
}

fn source_leaf(a: &Analysis, id: usize) -> bool {
    let chunk = &a.source_chunks[id];
    if !callable(&chunk.kind) {
        return !a
            .source_chunks
            .iter()
            .any(|child| child.parent == Some(id) && child.kind != "gap");
    }
    !a.source_chunks.iter().any(|child| {
        if !nested_declaration(&child.kind, child.name.as_deref()) {
            return false;
        }
        let mut parent = child.parent;
        while let Some(ancestor) = parent {
            if ancestor == id {
                return true;
            }
            parent = a.source_chunks[ancestor].parent;
        }
        false
    })
}

fn owner_leaf(a: &Analysis, id: usize) -> bool {
    let entity = &a.entities[id];
    if !callable(&entity.kind) {
        return !a.entities.iter().any(|child| child.parent == Some(id));
    }
    !a.entities.iter().any(|child| {
        if !nested_declaration(&child.kind, child.name.as_deref()) {
            return false;
        }
        let mut parent = child.parent;
        while let Some(ancestor) = parent {
            if ancestor == id {
                return true;
            }
            parent = a.entities[ancestor].parent;
        }
        false
    })
}

fn direct_leaf<'a>(a: &'a Analysis, c: &Candidate) -> Result<Option<(String, &'a str, &'a Span)>> {
    if let Some(id) = c.source_chunk {
        let chunk = a
            .source_chunks
            .get(id)
            .context("unknown candidate source chunk")?;
        if eligible(&chunk.kind) && source_leaf(a, id) {
            return Ok(Some((format!("c{id}"), &chunk.kind, &chunk.span)));
        }
    } else if let Some(id) = c.owner {
        let entity = a.entities.get(id).context("unknown candidate owner")?;
        if eligible(&entity.kind) && owner_leaf(a, id) {
            return Ok(Some((format!("e{id}"), &entity.kind, &entity.span)));
        }
    }
    Ok(None)
}

struct Piece {
    file: usize,
    leaf: Option<String>,
    kind: String,
    leaf_start: usize,
    candidate: Candidate,
    span: Span,
    text: String,
    complete_leaf: bool,
    // Prefix/suffix positions for complete source lines inside returned evidence.
    safe_start: usize,
    safe_end: usize,
}

impl Piece {
    fn new(
        file: usize,
        c: &Candidate,
        a: &Analysis,
        evidence: &Span,
        leaf: Option<(String, &str, &Span)>,
    ) -> Result<Option<Self>> {
        let start = leaf
            .as_ref()
            .map_or(evidence.start, |(_, _, s)| s.start.max(evidence.start));
        let end = leaf
            .as_ref()
            .map_or(evidence.end, |(_, _, s)| s.end.min(evidence.end));
        if start >= end {
            return Ok(None);
        }
        let source = &a.source.text;
        let text = source
            .get(start..end)
            .context("invalid UTF-8 evidence bounds")?;
        let safe_start = if start == 0 || source.as_bytes()[start - 1] == b'\n' {
            0
        } else {
            text.find('\n').map_or(text.len(), |i| i + 1)
        };
        let safe_end = if end == source.len() || text.ends_with('\n') {
            text.len()
        } else {
            text.rfind('\n').map_or(0, |i| i + 1)
        };
        Ok(Some(Self {
            file,
            leaf: leaf.as_ref().map(|(id, _, _)| id.clone()),
            kind: leaf
                .as_ref()
                .map_or("representative".into(), |(_, k, _)| (*k).into()),
            leaf_start: leaf.as_ref().map_or(start, |(_, _, s)| s.start),
            candidate: c.clone(),
            span: LineIndex::new(source).span(start, end),
            text: text.to_owned(),
            complete_leaf: leaf
                .as_ref()
                .is_some_and(|(_, _, s)| s.start == start && s.end == end),
            safe_start,
            safe_end,
        }))
    }

    fn rendered(&self, start: usize, end: usize, status: &str) -> String {
        let text = &self.text[start..end];
        let line_start =
            self.span.line_start + self.text[..start].bytes().filter(|&b| b == b'\n').count();
        let line_end = line_start + text.bytes().filter(|&b| b == b'\n').count()
            - usize::from(text.ends_with('\n'));
        let header = json!({"source_rank":self.file + 1,"candidate":self.candidate.id,
            "leaf":self.leaf,"kind":self.kind,"status":status,
            "bytes":[self.span.start + start,self.span.start + end],
            "lines":[line_start,line_end],"text_bytes":text.len()});
        format!("\nevidence: {header}\ntext: {text}\n")
    }

    #[cfg(test)]
    fn pack(&self, budget: usize) -> String {
        self.pack_with(budget, &str::len)
    }

    fn pack_with(&self, budget: usize, measure: &impl Fn(&str) -> usize) -> String {
        if self.complete_leaf {
            let full = self.rendered(0, self.text.len(), "complete indexed leaf");
            if measure(&full) <= budget {
                return full;
            }
        }
        let status = if self.leaf.is_some() {
            "partial leaf excerpt"
        } else {
            "representative fragment; not a complete leaf"
        };
        let mut best = String::new();
        if self.safe_start < self.safe_end {
            for end in self.text[self.safe_start..self.safe_end]
                .match_indices('\n')
                .map(|(i, _)| self.safe_start + i + 1)
                .chain(std::iter::once(self.safe_end))
            {
                let rendered = self.rendered(self.safe_start, end, status);
                if measure(&rendered) > budget {
                    break;
                }
                best = rendered;
            }
        }
        if !best.is_empty() {
            return best;
        }
        let omitted = format!(
            "\nevidence omitted: source {} candidate {}; no complete line fits; use indexed navigation above.\n",
            self.file + 1,
            self.candidate.id
        );
        if measure(&omitted) <= budget {
            omitted
        } else {
            String::new()
        }
    }
}

fn pieces(db: &Connection, results: &Response) -> Result<Vec<Piece>> {
    let mut all = Vec::new();
    for (file, result) in results.source.iter().enumerate() {
        let analysis = storage::analysis::load(db, &result.hit.representative.path)?
            .context("missing indexed source for presentation")?;
        ensure!(
            storage::processing::source_hash(&analysis.source.text) == result.snapshot_hash,
            "presentation snapshot mismatch"
        );
        let mut direct = Vec::new();
        for block in &result.blocks {
            // Guard the exact existing evidence; no working-tree source or new text.
            let expected = block
                .evidence
                .iter()
                .map(|e| {
                    analysis
                        .source
                        .text
                        .get(e.span.start..e.span.end)
                        .context("invalid returned evidence bounds")
                })
                .collect::<Result<Vec<_>>>()?
                .join("\n");
            ensure!(
                expected == block.text,
                "returned evidence differs from snapshot"
            );
            if let Some(leaf) = direct_leaf(&analysis, &block.document)? {
                for evidence in &block.evidence {
                    if let Some(piece) = Piece::new(
                        file,
                        &block.document,
                        &analysis,
                        &evidence.span,
                        Some((leaf.0.clone(), leaf.1, leaf.2)),
                    )? {
                        direct.push(piece);
                    }
                }
            }
        }
        if direct.is_empty() {
            let block = representative(result)?;
            if let Some(evidence) = block.evidence.first()
                && let Some(piece) =
                    Piece::new(file, &block.document, &analysis, &evidence.span, None)?
            {
                all.push(piece);
            }
        } else {
            all.extend(direct);
        }
    }
    all.sort_by(|a, b| {
        b.candidate
            .score()
            .total_cmp(&a.candidate.score())
            .then_with(|| {
                b.candidate
                    .semantic_score
                    .unwrap_or(0.0)
                    .total_cmp(&a.candidate.semantic_score.unwrap_or(0.0))
            })
            .then(a.file.cmp(&b.file))
            .then(a.leaf_start.cmp(&b.leaf_start))
            .then(a.candidate.id.cmp(&b.candidate.id))
            .then(a.span.start.cmp(&b.span.start))
    });
    let mut seen = HashSet::new();
    all.retain(|p| seen.insert((p.file, p.leaf.clone())));
    all.truncate(MAX_PRIMARY);
    Ok(all)
}

pub struct Prepared {
    navigation: String,
    selected: Vec<Piece>,
}
impl Prepared {
    pub fn new(db: &Connection, results: &Response) -> Result<Self> {
        let mut out = format!(
            "compact indexed evidence v1\nresults: {}\nevidence is partial; omitted bodies and detailed documentation/reference evidence remain available through ordinary source reads at the listed paths and ranges.\nNavigation bounds are indexed ranges, not a claim that a whole file or function is shown.\n",
            results.source.len()
        );
        for (rank, file) in results.source.iter().enumerate() {
            navigation(&mut out, "source", rank, file)?;
        }
        for (rank, file) in results.docs.iter().enumerate() {
            navigation(&mut out, "document", rank, file)?;
        }
        let mut seen = HashSet::new();
        for relation in &results.relations {
            if seen.insert((&relation.document_path, &relation.source_path)) {
                writeln!(
                    out,
                    "reference navigation: {}",
                    json!({"document":relation.document_path,"source":relation.source_path})
                )?;
            }
        }
        Ok(Self {
            navigation: out,
            selected: pieces(db, results)?,
        })
    }

    /// Measure either raw UTF-8 or the additive escaped content of a JSON string.
    pub fn render(&self, budget: usize, measure: &impl Fn(&str) -> usize) -> Result<String> {
        let mut out = self.navigation.clone();
        ensure!(
            measure(&out) <= budget,
            "compact navigation exceeds {budget} UTF-8 bytes; use full output or a smaller limit"
        );
        for (index, piece) in self.selected.iter().enumerate() {
            let share = (budget - measure(&out)) / (self.selected.len() - index);
            out.push_str(&piece.pack_with(share, measure));
        }
        ensure!(measure(&out) <= budget, "compact output budget exceeded");
        Ok(out)
    }
}

#[cfg(test)]
fn render(db: &Connection, results: &Response) -> Result<String> {
    Prepared::new(db, results)?.render(MAX_BYTES, &str::len)
}

#[cfg(test)]
#[path = "../../tests/unit/commands/compact.rs"]
mod tests;
