//! Doc references (ranking plan S4): a source file that a found doc names by
//! path, Markdown link, or dotted name joins the source list with part of the
//! doc's score. The rules and limits are TS v2's
//! (`src/internals/search/documents/`), with chunks in place of windows.

use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};

use anyhow::Result;
use regex::Regex;

use crate::chunk::own_text;
use crate::rank::{RankedFile, Ranking, is_doc, sort_files};
use crate::store::Store;

/// Docs whose found chunks are read for references.
const DOCS_READ: usize = 10;
/// Found chunks read per doc, best first.
const CHUNKS_PER_DOC: usize = 6;
/// References taken from one doc.
const REFERENCES_PER_DOC: usize = 3;
/// References taken in total.
const REFERENCES: usize = 10;
/// Share of the doc's score a referenced file gets.
const INHERITED_SCORE: f32 = 0.6;

/// The three reference forms TS v2 kept.
struct Patterns {
    /// A repository path with at least one folder and an extension, standing
    /// alone: `src/search/hybrid.ts`, `./lib/a.py`.
    explicit_path: Regex,
    /// The target of a Markdown link: `[text](target "title")`.
    markdown_link: Regex,
    /// A dotted name of three or more parts ending in a capitalized part:
    /// `django.db.migrations.state.ProjectState`.
    qualified_symbol: Regex,
}

impl Patterns {
    fn new() -> Result<Self> {
        Ok(Self {
            explicit_path: Regex::new(
                r#"(?:^|[\s`'"(<])((?:\.{0,2}/)?[A-Za-z0-9_@.-]+(?:/[A-Za-z0-9_@.+-]+)+\.[A-Za-z0-9][A-Za-z0-9.-]*)(?:$|[\s`'">),.:#])"#,
            )?,
            markdown_link: Regex::new(r#"\]\(([^)\s]+)(?:\s+"[^"]*")?\)"#)?,
            qualified_symbol: Regex::new(
                r"\b(?:[a-zA-Z_][a-zA-Z0-9_]*\.){2,}[A-Z][a-zA-Z0-9_]*\b",
            )?,
        })
    }
}

#[derive(Clone, PartialEq, Debug)]
enum Reference {
    Path(String),
    QualifiedSymbol(String),
}

/// A reference found in a doc, with the score the doc ranked with.
struct Found {
    doc_path: String,
    doc_score: f32,
    reference: Reference,
}

/// Add the files that the top docs name to `ranking.files`, then re-sort it.
pub fn expand(ranking: &mut Ranking, store: &Store) -> Result<()> {
    let found = find_references(&ranking.docs, store)?;
    if found.is_empty() {
        return Ok(());
    }
    let paths = store.paths()?;
    let source_paths: HashSet<&str> = paths
        .iter()
        .map(String::as_str)
        .filter(|path| !is_doc(path))
        .collect();
    let paths_by_module = module_paths(&source_paths);

    let mut relations: HashSet<(String, String, Option<i64>)> = HashSet::new();
    for item in found {
        let Some((path, chunk_id)) = resolve(&item, &source_paths, &paths_by_module, store)? else {
            continue;
        };
        let Some(chunk_id) =
            chunk_id.map_or_else(|| store.first_chunk(&path), |id| Ok(Some(id)))?
        else {
            continue;
        };
        if !relations.insert((item.doc_path.clone(), path.clone(), Some(chunk_id))) {
            continue;
        }
        inherit(
            &mut ranking.files,
            &path,
            chunk_id,
            item.doc_score * INHERITED_SCORE,
        );
        if relations.len() >= REFERENCES {
            break;
        }
    }
    sort_files(&mut ranking.files);
    Ok(())
}

/// The references in the found chunks of the top docs, within the limits.
fn find_references(docs: &[RankedFile], store: &Store) -> Result<Vec<Found>> {
    let patterns = Patterns::new()?;
    let mut found: Vec<Found> = Vec::new();
    for doc in docs.iter().take(DOCS_READ) {
        let stored = store.stored_file(&doc.path)?;
        let mut seen: Vec<Reference> = Vec::new();
        'chunks: for chunk_id in doc.chunk_ids.iter().take(CHUNKS_PER_DOC) {
            let Some(index) = stored.chunk_ids.iter().position(|id| id == chunk_id) else {
                continue;
            };
            let text = own_text(&stored.text, &stored.chunks, index);
            for reference in extract(&text, &patterns) {
                if seen.contains(&reference) {
                    continue;
                }
                seen.push(reference.clone());
                found.push(Found {
                    doc_path: doc.path.clone(),
                    doc_score: doc.score,
                    reference,
                });
                if seen.len() >= REFERENCES_PER_DOC || found.len() >= REFERENCES {
                    break 'chunks;
                }
            }
        }
        if found.len() >= REFERENCES {
            break;
        }
    }
    Ok(found)
}

/// Paths, then Markdown link targets that look like files, then dotted names,
/// each once.
fn extract(text: &str, patterns: &Patterns) -> Vec<Reference> {
    let mut references: Vec<Reference> = Vec::new();
    let mut add = |reference: Reference| {
        if !references.contains(&reference) {
            references.push(reference);
        }
    };
    for captures in patterns.explicit_path.captures_iter(text) {
        if let Some(value) = clean(&captures[1]) {
            add(Reference::Path(value));
        }
    }
    for captures in patterns.markdown_link.captures_iter(text) {
        let target = captures[1].split('#').next().unwrap_or_default();
        let file_name = target.rsplit('/').next().unwrap_or_default();
        if file_name.contains('.')
            && let Some(value) = clean(target)
        {
            add(Reference::Path(value));
        }
    }
    for found in patterns.qualified_symbol.find_iter(text) {
        if let Some(value) = clean(found.as_str()) {
            add(Reference::QualifiedSymbol(value));
        }
    }
    references
}

/// Trim spaces, leading `~`, and trailing punctuation; `None` when nothing is left.
fn clean(value: &str) -> Option<String> {
    let cleaned = value
        .trim()
        .trim_start_matches('~')
        .trim_end_matches([')', ',', '.', ';', ':']);
    (!cleaned.is_empty()).then(|| cleaned.to_string())
}

/// Every source file under its module names: `a/b/c` and `a.b.c` for
/// `a/b/c.py`, plus `a/b` and `a.b` for `a/b/index.ts`.
fn module_paths<'a>(source_paths: &HashSet<&'a str>) -> HashMap<String, Vec<&'a str>> {
    let mut sorted: Vec<&str> = source_paths.iter().copied().collect();
    sorted.sort_unstable();
    let mut modules: HashMap<String, Vec<&str>> = HashMap::new();
    for path in sorted {
        let stem = without_extension(path);
        let mut keys = vec![stem.to_string(), stem.replace('/', ".")];
        if let Some(parent) = stem.strip_suffix("/index") {
            keys.push(parent.to_string());
            keys.push(parent.replace('/', "."));
        }
        keys.dedup();
        for key in keys {
            modules.entry(key).or_default().push(path);
        }
    }
    modules
}

fn without_extension(path: &str) -> &str {
    let file_start = path.rfind('/').map_or(0, |slash| slash + 1);
    match path[file_start..].rfind('.') {
        Some(dot) => &path[..file_start + dot],
        None => path,
    }
}

/// The source file a reference names, and the chunk it names when it is a
/// symbol; `None` when it names nothing or more than one file.
fn resolve(
    item: &Found,
    source_paths: &HashSet<&str>,
    paths_by_module: &HashMap<String, Vec<&str>>,
    store: &Store,
) -> Result<Option<(String, Option<i64>)>> {
    match &item.reference {
        Reference::Path(value) => {
            Ok(resolve_path(value, &item.doc_path, source_paths).map(|path| (path, None)))
        }
        Reference::QualifiedSymbol(value) => {
            let (module, symbol) = value.rsplit_once('.').unwrap_or(("", value));
            let definitions = store.chunks_named(symbol)?;
            let module_files = paths_by_module.get(module).map_or(&[][..], Vec::as_slice);
            if let [path] = module_files {
                let chunk = definitions
                    .iter()
                    .find(|(definition_path, _)| definition_path == path)
                    .map(|(_, chunk_id)| *chunk_id);
                return Ok(Some((path.to_string(), chunk)));
            }
            let source_definitions: Vec<&(String, i64)> = definitions
                .iter()
                .filter(|(path, _)| source_paths.contains(path.as_str()))
                .collect();
            let definition_files: HashSet<&str> = source_definitions
                .iter()
                .map(|(path, _)| path.as_str())
                .collect();
            let Some((path, chunk_id)) = source_definitions.first() else {
                return Ok(None);
            };
            if definition_files.len() != 1 {
                return Ok(None);
            }
            let dotted_stem = without_extension(path).replace('/', ".");
            Ok(module
                .ends_with(&dotted_stem)
                .then(|| (path.clone(), Some(*chunk_id))))
        }
    }
}

/// An indexed source file that `value` names, read relative to the doc first
/// when it starts with `./` or `../`.
fn resolve_path(value: &str, doc_path: &str, source_paths: &HashSet<&str>) -> Option<String> {
    let value = value
        .split('#')
        .next()
        .unwrap_or_default()
        .replace('\\', "/");
    let mut candidates: Vec<String> = Vec::new();
    if value.starts_with("./") || value.starts_with("../") {
        let doc_folder = Path::new(doc_path).parent().unwrap_or(Path::new(""));
        if let Some(joined) = normalize(&doc_folder.join(&value)) {
            candidates.push(joined);
        }
    }
    candidates.push(value.trim_start_matches("./").to_string());
    candidates
        .into_iter()
        .find(|candidate| source_paths.contains(candidate.as_str()))
}

/// `a/b/../c` as `a/c`; `None` when the path climbs out of the project.
fn normalize(path: &Path) -> Option<String> {
    let mut parts = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => parts.push(part),
            Component::ParentDir if !parts.pop() => return None,
            _ => {}
        }
    }
    Some(parts.to_string_lossy().replace('\\', "/"))
}

/// Give `path` the `score` it inherits from a doc: a listed file keeps the
/// higher of its own and the inherited score; an unlisted file joins with it.
fn inherit(files: &mut Vec<RankedFile>, path: &str, chunk_id: i64, score: f32) {
    match files.iter_mut().find(|file| file.path == path) {
        Some(file) => {
            if file.chunk_ids.contains(&chunk_id) {
                // Already listed; its place in the order stays.
            } else if score > file.score {
                file.chunk_ids.insert(0, chunk_id);
            } else {
                file.chunk_ids.push(chunk_id);
            }
            file.score = file.score.max(score);
        }
        None => files.push(RankedFile {
            path: path.to_string(),
            score,
            chunk_ids: vec![chunk_id],
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn path(value: &str) -> Reference {
        Reference::Path(value.into())
    }

    fn extract_from(text: &str) -> Vec<Reference> {
        extract(text, &Patterns::new().unwrap())
    }

    #[test]
    fn extracts_paths_links_and_dotted_names_in_that_order() {
        let text = "See `src/search/hybrid.ts`, the [guide](../docs/setup.md#run) and \
                    django.db.migrations.state.ProjectState.";
        assert_eq!(
            extract_from(text),
            [
                path("src/search/hybrid.ts"),
                path("../docs/setup.md"),
                Reference::QualifiedSymbol("django.db.migrations.state.ProjectState".into()),
            ]
        );
    }

    #[test]
    fn ignores_words_with_dots_that_are_not_references() {
        assert!(extract_from("Use e.g. the ORM. Version 1.2.3 is out. foo.bar.baz").is_empty());
    }

    #[test]
    fn module_names_cover_dotted_and_index_forms() {
        let source: HashSet<&str> = ["django/db/state.py", "src/ui/index.ts"].into();
        let modules = module_paths(&source);
        assert_eq!(modules["django.db.state"], ["django/db/state.py"]);
        assert_eq!(modules["django/db/state"], ["django/db/state.py"]);
        assert_eq!(modules["src.ui"], ["src/ui/index.ts"]);
    }

    #[test]
    fn paths_resolve_relative_to_the_doc_first() {
        let source: HashSet<&str> = ["docs/lib/a.py", "lib/a.py"].into();
        assert_eq!(
            resolve_path("./lib/a.py", "docs/guide.md", &source).as_deref(),
            Some("docs/lib/a.py")
        );
        assert_eq!(
            resolve_path("lib/a.py", "docs/guide.md", &source).as_deref(),
            Some("lib/a.py")
        );
        assert_eq!(resolve_path("../../x.py", "docs/guide.md", &source), None);
    }

    #[test]
    fn an_inherited_score_never_lowers_a_file() {
        let mut files = vec![RankedFile {
            path: "a.py".into(),
            score: 0.5,
            chunk_ids: vec![1],
        }];
        inherit(&mut files, "a.py", 2, 0.3);
        inherit(&mut files, "b.py", 3, 0.4);
        assert_eq!(files[0].score, 0.5);
        assert_eq!(files[0].chunk_ids, [1, 2]);
        assert_eq!(files[1].path, "b.py");
        inherit(&mut files, "a.py", 4, 0.9);
        assert_eq!(files[0].score, 0.9);
        assert_eq!(files[0].chunk_ids, [4, 1, 2]);
    }
}
