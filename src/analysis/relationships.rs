//! Cross-file relationships derived from saved source chunks and facts.
use super::{
    Analysis,
    source_facts::{Binding, ChunkRef, Fact, Kind, Location},
};
use crate::retrieval::ts_v2::Chunk;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

mod dart;
mod direct;
mod ecmascript;
mod go;
mod haskell;
mod modules;
mod php;
mod python;
mod render;
mod ruby;
mod rust;
mod symbols;
mod types;
pub use render::render;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRelationship {
    pub kind: String,
    pub from_path: String,
    pub target_kind: String,
    pub to_path: String,
    pub source: String,
    pub facts: Vec<Fact>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReExportRelationship {
    pub kind: String,
    pub from_path: String,
    pub to_path: String,
    pub source: String,
    pub facts: Vec<Fact>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallRelationship {
    pub kind: String,
    pub from_path: String,
    pub from: Option<ChunkRef>,
    pub to_path: String,
    pub to: ChunkRef,
    pub fact: Fact,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Unresolved {
    pub path: String,
    pub fact: Fact,
}
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Relationships {
    pub imports: Vec<ImportRelationship>,
    pub re_exports: Vec<ReExportRelationship>,
    pub calls: Vec<CallRelationship>,
    pub unresolved_imports: Vec<Unresolved>,
    pub unresolved_re_exports: Vec<Unresolved>,
    pub unresolved_calls: Vec<Unresolved>,
}
#[derive(Default)]
pub struct Options {
    pub go_module_path: Option<String>,
    pub project_paths: Option<HashSet<String>>,
}
#[derive(Clone, Copy)]
struct Import<'a> {
    fact: &'a Fact,
    source: &'a str,
    imported: Option<&'a str>,
    local: Option<&'a str>,
    type_only: bool,
    is_static: bool,
    global: bool,
}
#[derive(Clone, Copy)]
struct Export<'a> {
    fact: &'a Fact,
    exported: &'a str,
    local: Option<&'a str>,
    source: Option<&'a str>,
    type_only: bool,
}
#[derive(Clone, Copy)]
struct Call<'a> {
    fact: &'a Fact,
    callee: &'a str,
    binding: Binding,
    target: Option<&'a ChunkRef>,
}
struct File<'a> {
    path: String,
    language: &'static str,
    analysis: &'a Analysis,
    top: Vec<ChunkRef>,
    imports: Vec<Import<'a>>,
    exports: Vec<Export<'a>>,
    calls: Vec<Call<'a>>,
}
impl<'a> File<'a> {
    fn new(analysis: &'a Analysis) -> Self {
        let mut file = Self {
            path: normalized(&analysis.source.path),
            language: language(&analysis.source.path),
            analysis,
            top: analysis
                .source_chunks
                .iter()
                .filter(|c| c.parent.is_none())
                .filter_map(chunk_ref)
                .collect(),
            imports: Vec::new(),
            exports: Vec::new(),
            calls: Vec::new(),
        };
        for fact in &analysis.source_facts {
            match &fact.kind {
                Kind::Import {
                    source,
                    imported,
                    local,
                    type_only,
                    is_static,
                    global,
                } => file.imports.push(Import {
                    fact,
                    source,
                    imported: imported.as_deref(),
                    local: local.as_deref(),
                    type_only: *type_only,
                    is_static: *is_static,
                    global: *global,
                }),
                Kind::Export {
                    exported,
                    local,
                    source,
                    type_only,
                } => file.exports.push(Export {
                    fact,
                    exported,
                    local: local.as_deref(),
                    source: source.as_deref(),
                    type_only: *type_only,
                }),
                Kind::Call {
                    callee,
                    binding,
                    target,
                } => file.calls.push(Call {
                    fact,
                    callee,
                    binding: *binding,
                    target: target.as_ref(),
                }),
            }
        }
        file
    }
}
struct Project<'a> {
    files: Vec<File<'a>>,
    paths: HashMap<String, usize>,
}
impl<'a> Project<'a> {
    fn new(input: &'a [Analysis]) -> Self {
        let files: Vec<_> = input.iter().map(File::new).collect();
        let paths = files
            .iter()
            .enumerate()
            .map(|(id, f)| (f.path.clone(), id))
            .collect();
        Self { files, paths }
    }
    fn file(&self, path: &str) -> Option<usize> {
        self.paths.get(path).copied()
    }
}
#[derive(Clone)]
struct Target {
    file: usize,
    chunk: ChunkRef,
}
struct ImportTarget {
    path: String,
    package: bool,
}
impl ImportTarget {
    fn file(project: &Project<'_>, file: usize) -> Self {
        Self {
            path: project.files[file].path.clone(),
            package: false,
        }
    }
}
fn language(path: &str) -> &'static str {
    let id = super::language::for_path(path)
        .identity
        .split('/')
        .next()
        .unwrap_or("text");
    if id == "text" && matches!(extension(path), "md" | "markdown" | "mdx") {
        "markdown"
    } else {
        id
    }
}
fn extension(path: &str) -> &str {
    path.rsplit('/')
        .next()
        .and_then(|name| name.rsplit_once('.'))
        .map(|(_, extension)| extension)
        .unwrap_or("")
}
fn normalized(path: &str) -> String {
    let path = path.replace('\\', "/");
    let absolute = path.starts_with('/');
    let mut parts = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." if parts.last().is_some_and(|p| *p != "..") => {
                parts.pop();
            }
            ".." if !absolute => parts.push(part),
            ".." => {}
            _ => parts.push(part),
        }
    }
    let value = format!("{}{}", if absolute { "/" } else { "" }, parts.join("/"));
    if value.is_empty() { ".".into() } else { value }
}
fn dirname(path: &str) -> &str {
    path.rsplit_once('/')
        .map(|(dir, _)| if dir.is_empty() { "/" } else { dir })
        .unwrap_or(".")
}
fn join(base: &str, path: &str) -> String {
    normalized(&format!("{base}/{path}"))
}
fn chunk_ref(chunk: &Chunk) -> Option<ChunkRef> {
    Some(ChunkRef {
        kind: chunk.kind.clone(),
        name: chunk.name.clone()?,
        location: Location::from_span(&chunk.span),
    })
}
fn callable(chunk: &ChunkRef) -> bool {
    matches!(chunk.kind.as_str(), "function" | "method")
}
fn unique(candidates: impl IntoIterator<Item = Target>) -> Option<Target> {
    let mut targets = HashMap::new();
    for target in candidates {
        targets.insert(
            (
                target.file,
                target.chunk.location.start_offset,
                target.chunk.location.end_offset,
            ),
            target,
        );
    }
    if targets.len() == 1 {
        targets.into_values().next()
    } else {
        None
    }
}
fn unique_files(project: &Project<'_>, files: impl IntoIterator<Item = usize>) -> Vec<usize> {
    let mut seen = HashSet::new();
    files
        .into_iter()
        .filter(|&id| seen.insert(project.files[id].path.clone()))
        .collect()
}
fn named_targets(project: &Project<'_>, file: usize, name: &str, kinds: &[&str]) -> Vec<Target> {
    project.files[file]
        .analysis
        .source_chunks
        .iter()
        .filter(|c| c.name.as_deref() == Some(name) && kinds.contains(&c.kind.as_str()))
        .filter_map(chunk_ref)
        .map(|chunk| Target { file, chunk })
        .collect()
}
fn without_type_args(text: &str) -> String {
    without_pairs(text, '<', '>')
}
fn without_pairs(text: &str, open: char, close: char) -> String {
    let mut result = String::new();
    let mut start = None;
    let mut copied = 0;
    for (offset, ch) in text.char_indices() {
        if ch == open {
            start = Some(offset);
        } else if ch == close
            && let Some(begin) = start.take()
        {
            result.push_str(&text[copied..begin]);
            copied = offset + 1;
        }
    }
    result.push_str(&text[copied..]);
    result
}
fn scheme(source: &str) -> bool {
    source.split_once(':').is_some_and(|(prefix, _)| {
        prefix.starts_with(|ch: char| ch.is_ascii_alphabetic())
            && prefix
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '+' | '.' | '-'))
    })
}
fn local_resource(file: &File<'_>, source: &str) -> Option<String> {
    if scheme(source) || source.starts_with("//") {
        return None;
    }
    let path = source.split(['?', '#']).next().filter(|s| !s.is_empty())?;
    Some(if let Some(path) = path.strip_prefix('/') {
        normalized(path)
    } else {
        join(dirname(&file.path), path)
    })
}
fn local_header(project: &Project<'_>, file: &File<'_>, source: &str) -> Option<usize> {
    let quoted = source
        .strip_prefix('"')?
        .strip_suffix('"')
        .filter(|s| !s.is_empty() && !s.contains('"'))?;
    project.file(&join(dirname(&file.path), quoted))
}
fn resource(language: &str) -> bool {
    matches!(language, "html" | "css" | "markdown")
}

use crate::collation::locale_compare as compare;

pub fn connect(input: &[Analysis], options: &Options) -> Relationships {
    let project = Project::new(input);
    let python = python::Index::new(&project);
    let go = go::Index::new(&project);
    let ruby = ruby::Index::new(&project);
    let haskell = haskell::Index::new(&project);
    let elixir = modules::Index::new(&project, "elixir");
    let ocaml = modules::Index::new(&project, "ocaml");
    let java = types::Index::new(&project, "java");
    let csharp = types::Index::new(&project, "csharp");
    let kotlin = symbols::Index::new(&project, "kotlin");
    let scala = symbols::Index::new(&project, "scala");
    let dart = dart::Index::new(&project);
    let php = php::Index::new(&project);
    let rust = rust::Index::new(&project);
    let mut result = Relationships::default();
    let mut import_keys = HashMap::new();
    let mut export_keys = HashMap::new();
    for (file_id, file) in project.files.iter().enumerate() {
        for &fact in &file.imports {
            let target = match file.language {
                "dart" => dart
                    .import(&project, file, fact)
                    .map(|id| ImportTarget::file(&project, id)),
                "php" => php
                    .import(&project, file, fact)
                    .map(|id| ImportTarget::file(&project, id)),
                "rust" => rust
                    .import(&project, file_id, fact)
                    .map(|id| ImportTarget::file(&project, id)),
                "kotlin" => kotlin.resolve_import(&project, fact),
                "scala" => scala.resolve_import(&project, fact),
                "java" => java.resolve_import(&project, fact),
                "csharp" => csharp.resolve_import(&project, fact),
                "elixir" => elixir
                    .resolve_import(&project, file_id, fact.source)
                    .map(|id| ImportTarget::file(&project, id)),
                "ocaml" => ocaml
                    .resolve_import(&project, file_id, fact.source)
                    .map(|id| ImportTarget::file(&project, id)),
                "ruby" => ruby::resolve_import(&project, file, fact)
                    .map(|id| ImportTarget::file(&project, id)),
                "haskell" => haskell
                    .resolve_import(&project, fact.source)
                    .map(|id| ImportTarget::file(&project, id)),
                "typescript" | "javascript" => {
                    ecmascript::resolve_import(&project, &file.path, fact.source)
                        .map(|id| ImportTarget::file(&project, id))
                }
                "python" => python
                    .resolve_import(&project, file_id, fact)
                    .map(|id| ImportTarget::file(&project, id)),
                "go" => go
                    .resolve_import(&project, file_id, fact, options)
                    .map(|package| ImportTarget {
                        path: package.directory.clone(),
                        package: true,
                    }),
                "bash" | "zig" | "lua" | "c" | "cpp" => {
                    direct::import(&project, file, fact).map(|id| ImportTarget::file(&project, id))
                }
                lang if resource(lang) => local_resource(file, fact.source)
                    .filter(|path| {
                        options
                            .project_paths
                            .as_ref()
                            .map(|p| p.contains(path))
                            .unwrap_or_else(|| project.paths.contains_key(path))
                    })
                    .map(|path| ImportTarget {
                        path,
                        package: false,
                    }),
                _ => None,
            };
            if let Some(target) = target {
                let key = (
                    file.path.clone(),
                    target.package,
                    target.path.clone(),
                    fact.source.to_owned(),
                );
                if let Some(&index) = import_keys.get(&key) {
                    let relation: &mut ImportRelationship = &mut result.imports[index];
                    relation.facts.push(fact.fact.clone());
                } else {
                    import_keys.insert(key, result.imports.len());
                    result.imports.push(ImportRelationship {
                        kind: "import".into(),
                        from_path: file.path.clone(),
                        target_kind: if target.package { "package" } else { "file" }.into(),
                        to_path: target.path,
                        source: fact.source.into(),
                        facts: vec![fact.fact.clone()],
                    });
                }
            } else {
                let local = match file.language {
                    "dart" => dart.local(fact.source),
                    "php" => php.local(&project, fact),
                    "rust" => rust.local(&project, file_id, fact),
                    "python" => {
                        fact.source.starts_with('.')
                            || python.has_root(fact.source.split('.').next().unwrap_or(""))
                    }
                    "go" => {
                        fact.source.starts_with('.')
                            || options.go_module_path.as_ref().is_some_and(|module| {
                                fact.source == module
                                    || fact.source.starts_with(&format!("{module}/"))
                            })
                    }
                    "kotlin" => kotlin.has_root(fact.source.split('.').next().unwrap_or("")),
                    "scala" => scala.has_root(fact.source.split('.').next().unwrap_or("")),
                    "java" => {
                        fact.imported != Some("module")
                            && java.has_root(fact.source.split('.').next().unwrap_or(""))
                    }
                    "csharp" => csharp.has_root(
                        fact.source
                            .strip_prefix("global::")
                            .unwrap_or(fact.source)
                            .split(['.', ':'])
                            .next()
                            .unwrap_or(""),
                    ),
                    "elixir" => elixir.has_root(fact.source.split('.').next().unwrap_or("")),
                    "ocaml" => ocaml.has_root(fact.source.split('.').next().unwrap_or("")),
                    "haskell" => haskell.has_root(fact.source.split('.').next().unwrap_or("")),
                    "ruby" => {
                        fact.imported == Some("require_relative")
                            || fact
                                .source
                                .strip_suffix(".rb")
                                .unwrap_or(fact.source)
                                .split('/')
                                .next()
                                .is_some_and(|root| {
                                    project.files.iter().any(|f| {
                                        f.language == "ruby"
                                            && (f.path.starts_with(&format!("{root}/"))
                                                || f.path.starts_with(&format!("lib/{root}/")))
                                    })
                                })
                    }
                    "bash" => {
                        !fact.source.starts_with('/')
                            && fact.source.contains('/')
                            && !normalized(fact.source).starts_with("../")
                    }
                    "zig" => fact.imported != Some("c-header") && fact.source.ends_with(".zig"),
                    "lua" => {
                        direct::lua_paths(fact.source)
                            .iter()
                            .any(|p| project.paths.contains_key(p))
                            || fact.source.split(['.', '/']).next().is_some_and(|root| {
                                project.files.iter().any(|f| {
                                    f.language == "lua" && f.path.starts_with(&format!("{root}/"))
                                })
                            })
                    }
                    "c" | "cpp" => {
                        fact.imported.is_none()
                            && fact
                                .source
                                .strip_prefix('"')
                                .and_then(|s| s.strip_suffix('"'))
                                .is_some_and(|s| !s.is_empty() && !s.contains('"'))
                    }
                    lang if resource(lang) => local_resource(file, fact.source).is_some(),
                    _ => fact.source.starts_with('.'),
                };
                if local {
                    result.unresolved_imports.push(Unresolved {
                        path: file.path.clone(),
                        fact: fact.fact.clone(),
                    });
                }
            }
        }
        for &fact in &file.exports {
            let Some(source) = fact.source.filter(|s| {
                if file.language == "dart" {
                    !scheme(s)
                } else {
                    s.starts_with('.')
                }
            }) else {
                continue;
            };
            let target = if file.language == "dart" {
                dart::Index::uri(&project, file, source)
            } else {
                ecmascript::resolve_import(&project, &file.path, source)
            };
            if let Some(target) = target {
                let path = project.files[target].path.clone();
                let key = (file.path.clone(), path.clone(), source.to_owned());
                if let Some(&index) = export_keys.get(&key) {
                    let relation: &mut ReExportRelationship = &mut result.re_exports[index];
                    relation.facts.push(fact.fact.clone());
                } else {
                    export_keys.insert(key, result.re_exports.len());
                    result.re_exports.push(ReExportRelationship {
                        kind: "re-export".into(),
                        from_path: file.path.clone(),
                        to_path: path,
                        source: source.into(),
                        facts: vec![fact.fact.clone()],
                    });
                }
            } else {
                result.unresolved_re_exports.push(Unresolved {
                    path: file.path.clone(),
                    fact: fact.fact.clone(),
                });
            }
        }
        for &fact in &file.calls {
            let mut target = if fact.binding == Binding::SourceChunk {
                fact.target.cloned().map(|chunk| Target {
                    file: file_id,
                    chunk,
                })
            } else {
                None
            };
            if target.is_none() {
                target = match file.language {
                    "dart" => dart.call(&project, file_id, fact),
                    "php" => php.call(&project, file_id, fact),
                    "rust" => rust.call(&project, file_id, fact),
                    "kotlin" => kotlin.call(&project, file_id, fact),
                    "scala" => scala.call(&project, file_id, fact),
                    "java" => java.call(&project, file_id, fact),
                    "csharp" => csharp.call(&project, file_id, fact),
                    "elixir" => elixir.call(&project, file_id, fact),
                    "ocaml" => ocaml.call(&project, file_id, fact),
                    "ruby" => ruby.call(&project, file_id, fact),
                    "haskell" => haskell.call(&project, file_id, fact),
                    "bash" | "zig" | "c" | "cpp" => direct::call(&project, file_id, fact),
                    "typescript" | "javascript" if fact.binding == Binding::Import => {
                        ecmascript::imported_target(&project, file_id, fact.callee)
                    }
                    "python" if fact.binding == Binding::Import => {
                        python.imported_target(&project, file_id, fact.callee)
                    }
                    "go" if matches!(fact.binding, Binding::Import | Binding::Unknown) => go
                        .imported_target(&project, file_id, fact.callee, options)
                        .or_else(|| {
                            (fact.binding == Binding::Unknown)
                                .then(|| go.same_package(&project, file_id, fact.callee))
                                .flatten()
                        }),
                    _ => None,
                };
            }
            if let Some(target) = target {
                result.calls.push(CallRelationship {
                    kind: "call".into(),
                    from_path: file.path.clone(),
                    from: fact.fact.owner.clone(),
                    to_path: project.files[target.file].path.clone(),
                    to: target.chunk,
                    fact: fact.fact.clone(),
                });
            } else {
                result.unresolved_calls.push(Unresolved {
                    path: file.path.clone(),
                    fact: fact.fact.clone(),
                });
            }
        }
    }
    result.imports.sort_by(|a, b| {
        compare(&a.from_path, &b.from_path)
            .then_with(|| compare(&a.to_path, &b.to_path))
            .then_with(|| compare(&a.source, &b.source))
    });
    result.re_exports.sort_by(|a, b| {
        compare(&a.from_path, &b.from_path)
            .then_with(|| compare(&a.to_path, &b.to_path))
            .then_with(|| compare(&a.source, &b.source))
    });
    result.calls.sort_by(|a, b| {
        compare(&a.from_path, &b.from_path).then_with(|| {
            a.fact
                .location
                .start_offset
                .cmp(&b.fact.location.start_offset)
        })
    });
    for values in [
        &mut result.unresolved_imports,
        &mut result.unresolved_re_exports,
        &mut result.unresolved_calls,
    ] {
        values.sort_by(|a, b| {
            compare(&a.path, &b.path).then_with(|| {
                a.fact
                    .location
                    .start_offset
                    .cmp(&b.fact.location.start_offset)
            })
        });
    }
    result
}

pub fn parse_go_module(source: &str) -> Option<String> {
    for line in source.lines() {
        let Some(rest) = line
            .trim_start()
            .strip_prefix("module")
            .filter(|s| s.starts_with(char::is_whitespace))
            .map(str::trim_start)
        else {
            continue;
        };
        let value = if let Some(rest) = rest.strip_prefix('"') {
            rest.split_once('"').map(|(s, _)| s)
        } else if let Some(rest) = rest.strip_prefix('`') {
            rest.split_once('`').map(|(s, _)| s)
        } else {
            rest.split_whitespace().next()
        };
        if let Some(value) = value.filter(|s| !s.is_empty()) {
            return Some(value.into());
        }
    }
    None
}
