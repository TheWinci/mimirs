use super::{Hit, Snapshots, ranking};
use crate::analysis::Span;
use anyhow::Result;
use regex::Regex;
use serde::Serialize;
use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    sync::LazyLock,
};

static EXPLICIT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?:^|[\s`'"(<])((?:\.{0,2}/)?[A-Za-z0-9_@.-]+(?:/[A-Za-z0-9_@.+-]+)+\.[A-Za-z0-9][A-Za-z0-9.-]*)(?:$|[\s`'">),.:#])"#).unwrap()
});
static LINK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"\]\(([^)\s]+)(?:\s+"[^"]*")?\)"#).unwrap());
static QUALIFIED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?-u:\b)(?:[a-zA-Z_][a-zA-Z0-9_]*\.){2,}[A-Z][a-zA-Z0-9_]*(?-u:\b)").unwrap()
});

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
    Path,
    QualifiedSymbol,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Reference {
    pub value: String,
    pub kind: Kind,
}

pub fn is_documentation(path: &str) -> bool {
    path.rsplit_once('.').is_some_and(|(_, ext)| {
        matches!(
            ext.to_ascii_lowercase().as_str(),
            "md" | "mdx" | "markdown" | "rst" | "txt" | "adoc"
        )
    })
}

pub fn extract(text: &str) -> Vec<Reference> {
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    let mut add = |value: &str, kind: Kind| {
        let value = value
            .trim()
            .trim_start_matches('~')
            .trim_end_matches([')', ',', '.', ';', ':']);
        let reference = Reference {
            value: value.to_owned(),
            kind,
        };
        if !value.is_empty() && seen.insert(reference.clone()) {
            result.push(reference);
        }
    };
    for m in EXPLICIT.captures_iter(text) {
        add(&m[1], Kind::Path);
    }
    for m in LINK.captures_iter(text) {
        let target = m[1].split('#').next().unwrap();
        if target.rsplit('/').next().unwrap().contains('.') {
            add(target, Kind::Path);
        }
    }
    for m in QUALIFIED.find_iter(text) {
        add(m.as_str(), Kind::QualifiedSymbol);
    }
    result
}

struct Pending {
    document: super::Candidate,
    score: f64,
    reference: Reference,
}

#[derive(Clone)]
struct Definition {
    path: String,
    name: String,
    span: Span,
}

#[derive(Serialize)]
pub struct Relation {
    pub document_window_id: i64,
    pub document_path: String,
    pub document_evidence: Vec<crate::retrieval::Evidence>,
    pub source_window_id: i64,
    pub source_path: String,
    pub source_range: Option<Span>,
    pub reference: String,
    pub symbol: Option<String>,
    pub kind: Kind,
    pub inherited_score: f64,
}

pub(super) fn segment(
    snapshots: &mut Snapshots<'_>,
    hits: Vec<Hit>,
) -> Result<(Vec<Hit>, Vec<Hit>, Vec<Relation>)> {
    let mut stmt = snapshots
        .db
        .prepare("SELECT path FROM files ORDER BY path")?;
    let paths = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<BTreeSet<_>>>()?;
    let (docs, source): (Vec<_>, Vec<_>) = hits
        .into_iter()
        .partition(|h| is_documentation(&h.representative.path));
    let mut pending = Vec::new();
    for document in docs.iter().take(10) {
        let windows = std::iter::once(&document.representative).chain(
            document
                .windows
                .iter()
                .filter(|w| w.id != document.representative.id),
        );
        let mut seen = HashSet::new();
        let mut accepted = 0;
        'windows: for window in windows.take(6) {
            for reference in extract(&snapshots.block(window)?.text) {
                if !seen.insert(reference.clone()) {
                    continue;
                }
                pending.push(Pending {
                    document: window.clone(),
                    score: document.score,
                    reference,
                });
                accepted += 1;
                if accepted >= 3 || pending.len() >= 10 {
                    break 'windows;
                }
            }
        }
        if pending.len() >= 10 {
            break;
        }
    }
    let names: Vec<_> = pending
        .iter()
        .filter(|p| p.reference.kind == Kind::QualifiedSymbol)
        .map(|p| p.reference.value.rsplit('.').next().unwrap().to_lowercase())
        .collect();
    let mut definitions: HashMap<String, Vec<Definition>> = HashMap::new();
    if !names.is_empty() {
        let has_chunks: bool = snapshots.db.query_row(
            "SELECT EXISTS(SELECT 1 FROM retrieval_documents WHERE source_chunk IS NOT NULL)",
            [],
            |r| r.get(0),
        )?;
        let table = if has_chunks {
            "source_chunks"
        } else {
            "entities"
        };
        let mut stmt=snapshots.db.prepare(&format!("SELECT f.path,e.name,e.byte_start,e.byte_end,e.line_start,e.line_end FROM {table} e
            JOIN files f ON f.id=e.file_id WHERE e.name COLLATE NOCASE IN (SELECT value FROM json_each(?1))
            ORDER BY e.name COLLATE NOCASE,f.path,e.byte_start,e.ordinal"))?;
        let rows = stmt.query_map([serde_json::to_string(&names)?], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, i64>(5)?,
            ))
        })?;
        for row in rows {
            let (path, name, start, end, line_start, line_end) = row?;
            definitions
                .entry(name.to_lowercase())
                .or_default()
                .push(Definition {
                    path,
                    name,
                    span: Span {
                        start: usize::try_from(start)?,
                        end: usize::try_from(end)?,
                        line_start: usize::try_from(line_start)?,
                        line_end: usize::try_from(line_end)?,
                    },
                });
        }
    }
    let modules = modules(&paths);
    let mut source: BTreeMap<_, _> = source
        .into_iter()
        .map(|h| (h.representative.path.clone(), h))
        .collect();
    let mut relations = Vec::new();
    let mut seen = HashSet::new();
    for pending in pending {
        let Some((path, definition)) = resolve(&pending, &paths, &modules, &definitions) else {
            continue;
        };
        let key = (
            pending.document.path.clone(),
            path.clone(),
            definition.as_ref().map(|d| d.name.clone()),
        );
        if seen.contains(&key) {
            continue;
        }
        let windows = snapshots.windows(&path)?;
        let file = snapshots.file(&path)?;
        let window = definition
            .as_ref()
            .and_then(|d| {
                windows.iter().find(|w| {
                    let owner = w
                        .source_chunk
                        .map(|id| &file.analysis.source_chunks[id].span)
                        .unwrap_or_else(|| {
                            w.owner.map_or(&file.analysis.scopes[0].span, |id| {
                                &file.analysis.entities[id].span
                            })
                        });
                    owner.start <= d.span.start && owner.end >= d.span.end
                })
            })
            .or_else(|| windows.first());
        let Some(window) = window else { continue };
        seen.insert(key);
        let inherited_score = pending.score * 0.6;
        let inherited = Hit {
            representative: window.clone(),
            score: inherited_score,
            semantic_score: 0.0,
            lexical_score: 0.0,
            windows: vec![window.clone()],
        };
        let hit = match source.remove(&path) {
            Some(existing) => ranking::merge(existing, inherited),
            None => inherited,
        };
        source.insert(path.clone(), hit);
        relations.push(Relation {
            document_window_id: pending.document.id,
            document_path: pending.document.path.clone(),
            document_evidence: snapshots.block(&pending.document)?.evidence,
            source_window_id: window.id,
            source_path: path,
            source_range: definition.as_ref().map(|d| d.span.clone()),
            reference: pending.reference.value,
            symbol: definition.map(|d| d.name),
            kind: pending.reference.kind,
            inherited_score,
        });
        if relations.len() >= 10 {
            break;
        }
    }
    let mut source: Vec<_> = source.into_values().collect();
    source.sort_by(ranking::compare_segmented);
    source.truncate(100);
    relations.retain(|r| {
        source
            .iter()
            .any(|s| s.representative.path == r.source_path)
    });
    Ok((source, docs.into_iter().take(5).collect(), relations))
}

fn stem(path: &str) -> &str {
    let name = path.rsplit('/').next().unwrap();
    match name.rfind('.') {
        Some(index) if index > 0 => &path[..path.len() - name.len() + index],
        _ => path,
    }
}

fn modules(paths: &BTreeSet<String>) -> HashMap<String, Vec<String>> {
    let mut modules: HashMap<String, Vec<String>> = HashMap::new();
    for path in paths.iter().filter(|p| !is_documentation(p)) {
        let stem = stem(path);
        let mut keys = HashSet::from([stem.to_owned(), stem.replace('/', ".")]);
        if let Some(parent) = stem.strip_suffix("/index") {
            keys.insert(parent.to_owned());
            keys.insert(parent.replace('/', "."));
        }
        for key in keys {
            modules.entry(key).or_default().push(path.clone());
        }
    }
    modules
}

fn resolve(
    pending: &Pending,
    paths: &BTreeSet<String>,
    modules: &HashMap<String, Vec<String>>,
    definitions: &HashMap<String, Vec<Definition>>,
) -> Option<(String, Option<Definition>)> {
    let value = &pending.reference.value;
    if pending.reference.kind == Kind::Path {
        let value = value.split('#').next().unwrap();
        let mut candidates = vec![super::super::ranking::normalized_path(value)];
        if value.starts_with("./") || value.starts_with("../") {
            let parent = pending
                .document
                .path
                .rsplit_once('/')
                .map_or("", |(parent, _)| parent);
            candidates.insert(0, normalize_join(parent, value));
        }
        return candidates
            .into_iter()
            .find(|p| {
                p != ".." && !p.starts_with("../") && paths.contains(p) && !is_documentation(p)
            })
            .map(|p| (p, None));
    }
    let (module, symbol) = value.rsplit_once('.')?;
    let module_paths = modules.get(module).map(Vec::as_slice).unwrap_or_default();
    let definitions = definitions
        .get(&symbol.to_lowercase())
        .map(Vec::as_slice)
        .unwrap_or_default();
    if module_paths.len() == 1 {
        return Some((
            module_paths[0].clone(),
            definitions
                .iter()
                .find(|d| d.path == module_paths[0])
                .cloned(),
        ));
    }
    let unique: HashSet<_> = definitions.iter().map(|d| &d.path).collect();
    if unique.len() != 1 {
        return None;
    }
    let definition = &definitions[0];
    module
        .ends_with(&stem(&definition.path).replace('/', "."))
        .then(|| (definition.path.clone(), Some(definition.clone())))
}

fn normalize_join(parent: &str, value: &str) -> String {
    let joined = if parent.is_empty() {
        value.to_owned()
    } else {
        format!("{parent}/{value}")
    };
    let mut components = Vec::new();
    for part in joined.split('/') {
        match part {
            "" | "." => (),
            ".." if components.last().is_some_and(|p| *p != "..") => {
                components.pop();
            }
            _ => components.push(part),
        }
    }
    components.join("/")
}
