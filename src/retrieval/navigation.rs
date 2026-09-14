//! One-hop selection from saved relationship facts. No parsing, indexing or model calls.
use crate::{
    analysis::source_facts::{ChunkRef, Fact},
    storage::{self, hybrid::Response},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

#[derive(Clone, Copy, Default, Deserialize, clap::ValueEnum)]
#[serde(rename_all = "lowercase")]
pub enum Intent {
    #[default]
    Auto,
    Task,
    Architecture,
}
impl Intent {
    pub fn architecture(self, query: &str) -> bool {
        match self {
            Self::Architecture => true,
            Self::Task => false,
            Self::Auto => query.split(|c: char| !c.is_alphanumeric()).any(|word| {
                matches!(
                    word.to_ascii_lowercase().as_str(),
                    "architecture" | "lifecycle" | "pipeline" | "stages" | "flow" | "ownership"
                )
            }),
        }
    }
}
#[derive(Clone, Serialize)]
struct Edge {
    kind: &'static str,
    from_path: String,
    to_path: String,
    from: Option<ChunkRef>,
    to: Option<ChunkRef>,
    fact: Fact,
}
fn priority(edge: &Edge, primary: &str, terms: &[String]) -> (bool, usize) {
    let label = format!(
        "{} {} {} {}",
        edge.from_path,
        edge.to_path,
        edge.from.as_ref().map_or("", |v| &v.name),
        edge.to.as_ref().map_or("", |v| &v.name)
    )
    .to_lowercase();
    (
        edge.from_path == primary || edge.to_path == primary,
        terms.iter().filter(|t| label.contains(t.as_str())).count(),
    )
}
fn gap(reason: &str) -> Value {
    json!({"status":"unavailable","candidate_nodes":0,"candidate_edges":0,"gaps":[reason]})
}
#[allow(clippy::too_many_arguments)]
pub fn expand(
    root: &Path,
    db: &rusqlite::Connection,
    results: &mut Response,
    query: &str,
    limit: usize,
    policy: Option<&str>,
    observe: &mut impl FnMut(&str) -> Option<String>,
) -> Value {
    let (snapshot, graph_bytes) = match crate::index::graph::navigation_snapshot(root) {
        Ok(s) => s,
        Err(e) => return gap(crate::files::preview(&format!("{e:#}"), 256)),
    };
    let Some(primary) = results
        .source
        .first()
        .map(|f| f.hit.representative.path.clone())
    else {
        return gap("no ranked source seed");
    };
    let Some(policy) = policy else {
        return gap("no indexed retrieval policy");
    };
    let seeds: BTreeSet<_> = results
        .source
        .iter()
        .take(2)
        .map(|f| f.hit.representative.path.clone())
        .collect();
    for file in results.source.iter().take(2) {
        let path = &file.hit.representative.path;
        if snapshot.source_hashes.get(path) != Some(&file.snapshot_hash)
            || observe(path).as_ref() != Some(&file.snapshot_hash)
        {
            return gap(
                "saved relationships do not match a ranked seed's indexed/current bytes; normal retrieval retained",
            );
        }
    }
    let terms: Vec<_> = query
        .split(|c: char| !c.is_alphanumeric())
        .filter(|s| !s.is_empty())
        .map(str::to_lowercase)
        .collect();
    let mut edges = Vec::new();
    let mut matching = 0usize;
    let mut consider = |edge: Edge| {
        if !seeds.contains(&edge.from_path) && !seeds.contains(&edge.to_path) {
            return;
        }
        if edge.from_path == edge.to_path {
            return;
        }
        if !snapshot.source_hashes.contains_key(&edge.from_path)
            || !snapshot.source_hashes.contains_key(&edge.to_path)
        {
            return;
        }
        matching += 1;
        edges.push(edge);
        edges.sort_by(|a, b| {
            priority(b, &primary, &terms)
                .cmp(&priority(a, &primary, &terms))
                .then_with(|| {
                    (
                        &a.from_path,
                        &a.to_path,
                        a.kind,
                        a.fact.location.start_offset,
                    )
                        .cmp(&(
                            &b.from_path,
                            &b.to_path,
                            b.kind,
                            b.fact.location.start_offset,
                        ))
                })
        });
        edges.truncate(16);
    };
    for e in &snapshot.relationships.calls {
        consider(Edge {
            kind: "call",
            from_path: e.from_path.clone(),
            to_path: e.to_path.clone(),
            from: e.from.clone(),
            to: Some(e.to.clone()),
            fact: e.fact.clone(),
        });
    }
    for e in &snapshot.relationships.imports {
        for fact in &e.facts {
            consider(Edge {
                kind: "import",
                from_path: e.from_path.clone(),
                to_path: e.to_path.clone(),
                from: fact.owner.clone(),
                to: None,
                fact: fact.clone(),
            });
        }
    }
    for e in &snapshot.relationships.re_exports {
        for fact in &e.facts {
            consider(Edge {
                kind: "reference",
                from_path: e.from_path.clone(),
                to_path: e.to_path.clone(),
                from: fact.owner.clone(),
                to: None,
                fact: fact.clone(),
            });
        }
    }
    let mut nodes = seeds.clone();
    edges.retain(|e| {
        let extra = [&e.from_path, &e.to_path]
            .iter()
            .filter(|p| !nodes.contains(p.as_str()))
            .count();
        if nodes.len() + extra > 12 {
            return false;
        }
        nodes.insert(e.from_path.clone());
        nodes.insert(e.to_path.clone());
        true
    });
    let edge_count = edges.len();
    let mut chosen = vec![primary.clone()];
    let mut hydrated = BTreeMap::new();
    let mut reasons = BTreeMap::from([(primary.clone(), "primary ranked seed".to_owned())]);
    let mut gaps = vec!["Saved relationship facts; resolver/configuration inputs were not revalidated for this request.".to_owned()];
    for edge in &edges {
        if chosen.len() >= limit {
            break;
        }
        let (path, offset) = if seeds.contains(&edge.from_path) {
            (
                &edge.to_path,
                edge.to.as_ref().map_or(0, |r| r.location.start_offset),
            )
        } else {
            (&edge.from_path, edge.fact.location.start_offset)
        };
        if chosen.contains(path) {
            continue;
        }
        let expected = &snapshot.source_hashes[path];
        if observe(path).as_ref() != Some(expected) {
            gaps.push(format!(
                "{path}: relationship binding differs from working bytes; adjacency evidence omitted"
            ));
            continue;
        }
        let existing = results
            .source
            .iter()
            .find(|f| f.hit.representative.path == *path);
        if let Some(file) = existing {
            if file.snapshot_hash != *expected {
                gaps.push(format!(
                    "{path}: indexed snapshot differs from saved relationship evidence"
                ));
                continue;
            }
        } else {
            match storage::hybrid::at_path(db, path, offset, policy) {
                Ok(file) if file.snapshot_hash == *expected => {
                    hydrated.insert(path.clone(), file);
                }
                _ => {
                    gaps.push(format!("{path}: matching indexed source unavailable"));
                    continue;
                }
            }
        }
        chosen.push(path.clone());
        reasons.insert(
            path.clone(),
            format!(
                "one-hop {} relationship between {} and {}",
                edge.kind, edge.from_path, edge.to_path
            ),
        );
    }
    let mut original = std::mem::take(&mut results.source);
    for path in chosen {
        if let Some(i) = original
            .iter()
            .position(|f| f.hit.representative.path == path)
        {
            results.source.push(original.remove(i));
        } else if let Some(file) = hydrated.remove(&path) {
            results.source.push(file);
        }
    }
    results.source.extend(
        original
            .into_iter()
            .take(limit.saturating_sub(results.source.len())),
    );
    let selected: BTreeSet<_> = results
        .source
        .iter()
        .map(|f| f.hit.representative.path.clone())
        .collect();
    results
        .relations
        .retain(|r| selected.contains(&r.source_path));
    // Ranked fallback can contain a neighbor rejected above. Graph citations need
    // agreement with both its indexed snapshot and this request's observed bytes.
    let graph_bound: BTreeSet<_> = results
        .source
        .iter()
        .filter(|file| {
            let path = &file.hit.representative.path;
            snapshot.source_hashes.get(path) == Some(&file.snapshot_hash)
                && observe(path).as_ref() == Some(&file.snapshot_hash)
        })
        .map(|file| file.hit.representative.path.clone())
        .collect();
    let selected_edges: Vec<_> = edges
        .iter()
        .filter(|e| graph_bound.contains(&e.from_path) && graph_bound.contains(&e.to_path))
        .collect();
    let unresolved: Vec<_> = snapshot
        .relationships
        .unresolved_calls
        .iter()
        .filter(|u| graph_bound.contains(&u.path))
        .collect();
    for u in unresolved.iter().take(4) {
        gaps.push(format!(
            "{}:{}: unresolved call; execution target is unknown",
            u.path, u.fact.location.start_line
        ));
    }
    let mut operations = BTreeMap::new();
    let mut cited_edges = Vec::new();
    for edge in &selected_edges {
        for (path, definition) in [
            (&edge.from_path, edge.from.as_ref()),
            (&edge.to_path, edge.to.as_ref()),
        ] {
            if let Some(definition) = definition {
                operations.insert((path.clone(), definition.location.start_offset, definition.name.clone()),
                    json!({"path":path,"name":definition.name,"kind":definition.kind,"lines":[definition.location.start_line,definition.location.end_line],"bytes":[definition.location.start_offset,definition.location.end_offset]}));
            }
        }
        cited_edges.push(json!({"kind":edge.kind,
            "from":{"path":edge.from_path,"name":edge.from.as_ref().map(|d| &d.name),"lines":[edge.fact.location.start_line,edge.fact.location.end_line],"bytes":[edge.fact.location.start_offset,edge.fact.location.end_offset]},
            "to":{"path":edge.to_path,"name":edge.to.as_ref().map(|d| &d.name),"lines":edge.to.as_ref().map(|d| [d.location.start_line,d.location.end_line]),"bytes":edge.to.as_ref().map(|d| [d.location.start_offset,d.location.end_offset])}}));
    }
    if cited_edges.is_empty() {
        gaps.push("No resolved link connects the returned source files; follow ordinary indexed citations for further investigation.".into());
    }
    let hashes: BTreeMap<_, _> = snapshot
        .source_hashes
        .iter()
        .filter(|(path, _)| graph_bound.contains(*path))
        .collect();
    json!({"status":"indexed_unvalidated","snapshot":snapshot.inputs,"source_hashes":hashes,
        "saved_view_reads":1,"saved_view_bytes_read":graph_bytes,"candidate_nodes":nodes.len(),"candidate_edges":edge_count,"omitted_edges":matching-selected_edges.len(),"unresolved_calls":unresolved.len(),
        "selection":results.source.iter().map(|f| json!({"path":f.hit.representative.path,"reason":reasons.get(&f.hit.representative.path).map(String::as_str).unwrap_or("ranked source fallback")})).collect::<Vec<_>>(),
        "operations":operations.into_values().collect::<Vec<_>>(),"edges":cited_edges,"gaps":gaps})
}
