//! Opt-in stable named declaration evidence. Whole-file SHA values retain their meaning.
use super::{
    checkout::Checkout,
    fingerprint,
    model::{FileEvidence, validate_path},
};
use crate::{
    analysis::{self, Span},
    source::SourceFile,
};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};

pub const EVALUATOR: &str = "named-rust-declaration-context-v1";
pub const CONTRACT: &str = "Anchor captures the named Rust declaration, associated attributes/docs, named enclosing declaration headers and crate attributes. Matching captured regions does not verify unlisted imports, configuration, callers or dependencies. Other languages and anonymous ownership are unsupported; attach whole files explicitly when needed.";
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Named {
    pub kind: String,
    pub name: String,
}
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Selector {
    pub version: u32,
    pub kind: String,
    pub name: String,
    #[serde(default)]
    pub owners: Vec<Named>,
}
impl Selector {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.version == 1,
            "unsupported anchor selector version {}",
            self.version
        );
        ensure!(
            !self.kind.is_empty()
                && !self.name.is_empty()
                && self
                    .owners
                    .iter()
                    .all(|o| !o.kind.is_empty() && !o.name.is_empty()),
            "anchor requires named kind/name and named owners"
        );
        Ok(())
    }
}
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Spec {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selector: Option<Selector>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
}
impl Spec {
    pub fn file(path: &str) -> Self {
        Self {
            path: path.into(),
            selector: None,
            provider: None,
        }
    }
    pub fn identity(&self) -> String {
        serde_json::to_string(&(&self.path, &self.selector)).unwrap()
    }
    pub fn from_evidence(e: &FileEvidence) -> Self {
        Self {
            path: e.path.clone(),
            selector: e.anchor.as_ref().map(|a| a.selector.clone()),
            provider: e.anchor.as_ref().map(|a| a.provider.clone()),
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Anchor {
    pub selector: Selector,
    pub provider: String,
    pub region_sha256: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Region {
    pub role: String,
    pub span: Span,
    pub text: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Resolved {
    pub provider: String,
    pub region_sha256: String,
    pub regions: Vec<Region>,
}
pub fn provider(path: &str) -> String {
    format!(
        "{EVALUATOR}|{}",
        analysis::language::for_path(path).identity
    )
}
pub fn current_identity() -> String {
    format!(
        "{EVALUATOR}|{}",
        analysis::language::for_path("source.rs").identity
    )
}
pub fn resolve(
    source: &SourceFile,
    selector: &Selector,
    expected: Option<&str>,
) -> Result<Resolved> {
    selector.validate()?;
    let identity = provider(&source.path);
    ensure!(
        expected.is_none_or(|v| v == identity),
        "anchor provider changed or unavailable; inspect an explicit current selector before replacing support"
    );
    ensure!(
        std::path::Path::new(&source.path)
            .extension()
            .is_some_and(|e| e == "rs"),
        "precise anchors currently support Rust declarations only; whole-file evidence remains available"
    );
    ensure!(
        matches!(
            selector.kind.as_str(),
            "function"
                | "method"
                | "struct"
                | "enum"
                | "trait"
                | "impl"
                | "type"
                | "const"
                | "static"
                | "module"
        ),
        "unsupported anchor declaration kind"
    );
    let a = analysis::extract(SourceFile {
        path: source.path.clone(),
        text: source.text.clone(),
    })?;
    ensure!(
        a.diagnostics.is_empty(),
        "syntax diagnostics make anchor ownership unavailable"
    );
    let owners = |mut parent: Option<usize>| -> Result<Vec<Named>> {
        let mut names = Vec::new();
        while let Some(id) = parent {
            let e = &a.entities[id];
            ensure!(
                matches!(e.kind.as_str(), "module" | "trait" | "impl"),
                "unsupported enclosing ownership; use whole-file evidence"
            );
            names.push(Named {
                kind: e.kind.clone(),
                name: e
                    .name
                    .clone()
                    .context("anonymous owner has no stable selector")?,
            });
            parent = e.parent;
        }
        names.reverse();
        Ok(names)
    };
    let candidates = a
        .entities
        .iter()
        .enumerate()
        .filter(|(_, e)| e.kind == selector.kind && e.name.as_deref() == Some(&selector.name))
        .filter_map(|(id, e)| match owners(e.parent) {
            Ok(names) if names == selector.owners => Some(id),
            _ => None,
        })
        .collect::<Vec<_>>();
    ensure!(
        candidates.len() == 1,
        "anchor selector must resolve uniquely; found {} candidates (renamed, reparented, unsupported ownership or ambiguous declaration)",
        candidates.len()
    );
    let id = candidates[0];
    // Analysis parent links cover named declarations. Reject syntax containers
    // they intentionally do not name, such as foreign/extern blocks, rather
    // than silently dropping their enclosing declaration context.
    let mut parser = tree_sitter::Parser::new();
    parser.set_language(&tree_sitter_rust::LANGUAGE.into())?;
    let tree = parser
        .parse(&source.text, None)
        .context("anchor ownership tree unavailable")?;
    let node = tree
        .root_node()
        .descendant_for_byte_range(a.entities[id].span.start, a.entities[id].span.end)
        .context("anchor declaration syntax unavailable")?;
    let mut parent_node = node.parent();
    while let Some(node) = parent_node {
        ensure!(
            matches!(
                node.kind(),
                "source_file" | "declaration_list" | "impl_item" | "trait_item" | "mod_item"
            ),
            "unsupported enclosing syntax {}; attach whole-file evidence explicitly",
            node.kind()
        );
        parent_node = node.parent();
    }
    let mut regions = Vec::new();
    let mut push = |role: String, span: Span| {
        regions.push(Region {
            role,
            text: source.text[span.start..span.end].into(),
            span,
        });
    };
    let leading = |owner: usize| {
        a.facts
            .iter()
            .filter(|f| {
                f.owner == Some(owner)
                    && matches!(f.kind.as_str(), "attribute" | "doc")
                    && f.span.end <= a.entities[owner].span.start
            })
            .map(|f| f.span.start)
            .min()
            .unwrap_or(a.entities[owner].span.start)
    };
    push(
        "declaration".into(),
        analysis::LineIndex::new(&source.text).span(leading(id), a.entities[id].span.end),
    );
    let mut parent = a.entities[id].parent;
    while let Some(owner) = parent {
        let signature = a
            .facts
            .iter()
            .find(|f| f.owner == Some(owner) && f.kind == "signature")
            .context("enclosing declaration header unavailable; use whole-file evidence")?;
        push(
            format!(
                "owner:{}:{}",
                a.entities[owner].kind,
                a.entities[owner].name.as_deref().unwrap_or("")
            ),
            analysis::LineIndex::new(&source.text).span(leading(owner), signature.span.end),
        );
        for f in a.facts.iter().filter(|f| {
            f.owner == Some(owner) && f.kind == "attribute" && f.span.start >= signature.span.end
        }) {
            push("owner_attribute".into(), f.span.clone());
        }
        parent = a.entities[owner].parent;
    }
    for f in a
        .facts
        .iter()
        .filter(|f| f.owner.is_none() && matches!(f.kind.as_str(), "attribute" | "doc"))
    {
        push("crate_context".into(), f.span.clone());
    }
    let digest = fingerprint(&serde_json::to_vec(
        &regions
            .iter()
            .map(|r| (&r.role, &r.text))
            .collect::<Vec<_>>(),
    )?);
    Ok(Resolved {
        provider: identity,
        region_sha256: digest,
        regions,
    })
}
pub fn capture_from_source(source: &SourceFile, spec: &Spec) -> Result<FileEvidence> {
    validate_path(&spec.path)?;
    ensure!(source.path == spec.path, "evidence source path mismatch");
    ensure!(
        spec.selector.is_some() || spec.provider.is_none(),
        "provider requires an anchor selector"
    );
    let anchor = spec
        .selector
        .as_ref()
        .map(|selector| {
            let resolved = resolve(source, selector, spec.provider.as_deref())?;
            Ok::<_, anyhow::Error>(Anchor {
                selector: selector.clone(),
                provider: resolved.provider,
                region_sha256: resolved.region_sha256,
            })
        })
        .transpose()?;
    Ok(FileEvidence {
        path: spec.path.clone(),
        sha256: fingerprint(source.text.as_bytes()),
        anchor,
        committed: None,
    })
}
pub fn capture_set(checkout: &Checkout, specs: &[Spec]) -> Result<Vec<FileEvidence>> {
    ensure!(!specs.is_empty(), "complete nonempty evidence is required");
    let mut unique = std::collections::BTreeMap::new();
    let mut sources = std::collections::BTreeMap::new();
    let mut output = Vec::new();
    for spec in specs {
        validate_path(&spec.path)?;
        if let Some(prior) = unique.insert(spec.identity(), spec) {
            ensure!(
                prior == spec,
                "conflicting providers for the same evidence identity"
            );
            continue;
        }
        if !sources.contains_key(&spec.path) {
            sources.insert(
                spec.path.clone(),
                checkout
                    .read(&spec.path)?
                    .context("evidence source missing")?,
            );
        }
        let mut captured = capture_from_source(&sources[&spec.path], spec)?;
        captured.committed =
            super::conversion::inspect(checkout, &spec.path, sources[&spec.path].text.as_bytes())?
                .1;
        output.push(captured);
    }
    Ok(output)
}
pub fn inputs(paths: &[String], anchors: &[Spec]) -> Result<Vec<Spec>> {
    ensure!(
        anchors.iter().all(|s| s.selector.is_some()),
        "--anchor/anchors requires a selector"
    );
    Ok(paths
        .iter()
        .map(|p| Spec::file(p))
        .chain(anchors.iter().cloned())
        .collect())
}
pub fn parse(value: &str) -> std::result::Result<Spec, String> {
    serde_json::from_str(value).map_err(|e| e.to_string())
}
pub fn parse_selector(value: &str) -> std::result::Result<Selector, String> {
    serde_json::from_str(value).map_err(|e| e.to_string())
}

#[cfg(test)]
#[path = "../../tests/unit/anchors.rs"]
mod tests;
